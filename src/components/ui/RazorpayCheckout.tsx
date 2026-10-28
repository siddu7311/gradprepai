/**
 * RazorpayCheckout
 *
 * Opens the Razorpay hosted checkout as a popup modal.
 *
 * Design decisions:
 *  - Uses createPortal to a plain <div> (NOT Radix Dialog) so that
 *    react-remove-scroll never sets overflow:hidden on <body> before
 *    rzp.open() reads body styles — which would force Razorpay into
 *    full-page redirect mode.
 *  - Calls rzp.open() inside requestAnimationFrame so the browser
 *    flushes DOM changes before Razorpay reads layout.
 *  - purgeRazorpayDOM() removes any leftover #razorpay-container /
 *    razorpay style tags from previous sessions on mount and dismiss.
 */
import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Crown, X, Loader2, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { GlowButton } from './GlowButton';
import { supabase } from '@/integrations/supabase/client';
import { useSubscription, PLANS } from '@/hooks/useSubscription';
import { useToast } from '@/hooks/use-toast';
import { useState } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = 'idle' | 'creating' | 'open' | 'verifying' | 'success' | 'pending' | 'failed';

interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill: { name: string; email: string };
  theme: { color: string };
  modal: { ondismiss: () => void; backdropclose: boolean };
  handler: (response: RazorpayResponse) => void;
}

interface RazorpayResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Razorpay: new (options: RazorpayOptions) => { open: () => void; close: () => void };
  }
}

export interface RazorpayCheckoutProps {
  isOpen: boolean;
  onClose: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Remove any Razorpay DOM artefacts left from previous or ongoing sessions. */
function purgeRazorpayDOM() {
  document.getElementById('razorpay-container')?.remove();
  document.querySelectorAll('style[id^="razorpay"]').forEach((el) => el.remove());
  document.querySelectorAll('iframe[src*="razorpay"]').forEach((el) => el.remove());
}

/** Dynamically load the Razorpay checkout.js script (once). */
function loadRazorpayScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) { resolve(); return; }
    const existing = document.querySelector('script[src*="checkout.razorpay.com"]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', reject);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RazorpayCheckout({ isOpen, onClose }: RazorpayCheckoutProps) {
  const [step, setStep] = useState<Step>('idle');
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const rzpRef = useRef<InstanceType<typeof window.Razorpay> | null>(null);
  const { checkSubscription } = useSubscription();
  const { toast } = useToast();

  // Clean up DOM on mount and whenever the modal closes.
  useEffect(() => {
    purgeRazorpayDOM();
  }, []);

  const resetAndClose = useCallback(() => {
    rzpRef.current?.close();
    rzpRef.current = null;
    purgeRazorpayDOM();
    setStep('idle');
    setErrorMsg(null);
    setExpiresAt(null);
    onClose();
  }, [onClose]);

  const startCheckout = useCallback(async () => {
    setStep('creating');
    setErrorMsg(null);

    try {
      // 1. Load Razorpay script
      await loadRazorpayScript();

      // 2. Create order server-side
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error('Not authenticated');

      const { data: orderData, error: orderErr } = await supabase.functions.invoke(
        'create-razorpay-order',
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (orderErr || orderData?.error) {
        throw new Error(orderData?.error ?? orderErr?.message ?? 'Could not create order');
      }

      const { key_id, order_id, amount, currency, name, description, prefill } = orderData;

      // 3. Build Razorpay instance
      const options: RazorpayOptions = {
        key:         key_id,
        order_id,
        amount,
        currency,
        name,
        description,
        prefill:     { name: prefill?.name ?? '', email: prefill?.email ?? '' },
        theme:       { color: '#00FFFF' },
        modal: {
          ondismiss:   () => setStep('idle'),
          backdropclose: false,
        },
        handler: async (response) => {
          setStep('verifying');
          try {
            const { data: verifyData, error: verifyErr } = await supabase.functions.invoke(
              'verify-razorpay-payment',
              {
                body: {
                  razorpay_order_id:   response.razorpay_order_id,
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_signature:  response.razorpay_signature,
                },
                headers: { Authorization: `Bearer ${token}` },
              },
            );

            if (verifyErr || verifyData?.error) {
              setStep('failed');
              setErrorMsg(verifyData?.error ?? verifyErr?.message ?? 'Verification failed');
              return;
            }

            if (verifyData?.pending) {
              setStep('pending');
              toast({ title: 'Payment received!', description: 'Pro access will activate shortly.' });
              return;
            }

            if (verifyData?.success) {
              setStep('success');
              setExpiresAt(verifyData.expires_at ?? null);
              checkSubscription();
              toast({ title: '🎉 Welcome to Pro!', description: 'Your Pro access is now active.' });
            }
          } catch (err) {
            setStep('failed');
            setErrorMsg(err instanceof Error ? err.message : 'Verification error');
          }
        },
      };

      rzpRef.current = new window.Razorpay(options);
      setStep('open');

      // 4. Let the browser flush DOM (clears any overflow:hidden) before Razorpay reads layout.
      requestAnimationFrame(() => {
        rzpRef.current?.open();
      });
    } catch (err) {
      setStep('failed');
      setErrorMsg(err instanceof Error ? err.message : 'Could not start checkout');
    }
  }, [checkSubscription, toast]);

  // Auto-start checkout as soon as the modal is opened.
  useEffect(() => {
    if (isOpen && step === 'idle') {
      startCheckout();
    }
    if (!isOpen) {
      rzpRef.current?.close();
      rzpRef.current = null;
      purgeRazorpayDOM();
      setStep('idle');
      setErrorMsg(null);
      setExpiresAt(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // ── Overlay (shown while creating order, verifying, or after final states) ──
  const showOverlay = isOpen && step !== 'open';

  return createPortal(
    <AnimatePresence>
      {showOverlay && (
        <>
          {/* Backdrop */}
          <motion.div
            key="rzp-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-background/80 backdrop-blur-sm z-[9999]"
            onClick={step === 'success' || step === 'failed' || step === 'pending' ? resetAndClose : undefined}
          />

          {/* Card */}
          <motion.div
            key="rzp-card"
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="fixed inset-0 z-[10000] flex items-center justify-center p-4 pointer-events-none"
          >
            <div className="w-full max-w-sm pointer-events-auto glass border border-primary/30 rounded-2xl p-8 shadow-glow bg-background text-center">

              {/* Close button (only on terminal states) */}
              {(step === 'success' || step === 'failed' || step === 'pending') && (
                <button
                  onClick={resetAndClose}
                  className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              )}

              {/* Creating / verifying */}
              {(step === 'creating' || step === 'verifying') && (
                <>
                  <Loader2 className="w-12 h-12 text-primary animate-spin mx-auto mb-4" />
                  <p className="text-foreground font-medium">
                    {step === 'creating' ? 'Opening payment gateway…' : 'Verifying payment…'}
                  </p>
                  <p className="text-sm text-muted-foreground mt-2">Please wait a moment</p>
                </>
              )}

              {/* Success */}
              {step === 'success' && (
                <>
                  <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-4" />
                  <h3 className="font-display text-xl font-bold text-foreground mb-2">Payment Successful!</h3>
                  <p className="text-muted-foreground text-sm mb-1">
                    <Crown className="w-4 h-4 inline mr-1 text-primary" />
                    Pro access activated
                  </p>
                  {expiresAt && (
                    <p className="text-xs text-muted-foreground mb-6">
                      Valid till {new Date(expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
                    </p>
                  )}
                  <GlowButton onClick={resetAndClose} className="w-full">Done</GlowButton>
                </>
              )}

              {/* Pending */}
              {step === 'pending' && (
                <>
                  <Clock className="w-12 h-12 text-yellow-500 mx-auto mb-4" />
                  <h3 className="font-display text-xl font-bold text-foreground mb-2">Payment Received</h3>
                  <p className="text-muted-foreground text-sm mb-6">
                    Your Pro access will activate within a few minutes once the payment is confirmed.
                  </p>
                  <GlowButton onClick={resetAndClose} className="w-full">Got it</GlowButton>
                </>
              )}

              {/* Failed */}
              {step === 'failed' && (
                <>
                  <XCircle className="w-12 h-12 text-destructive mx-auto mb-4" />
                  <h3 className="font-display text-xl font-bold text-foreground mb-2">Payment Failed</h3>
                  <p className="text-sm text-muted-foreground mb-6">
                    {errorMsg ?? 'Something went wrong. Please try again.'}
                  </p>
                  <div className="flex gap-3">
                    <GlowButton variant="outline" onClick={resetAndClose} className="flex-1">Cancel</GlowButton>
                    <GlowButton onClick={() => { setStep('idle'); startCheckout(); }} className="flex-1">Retry</GlowButton>
                  </div>
                </>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
