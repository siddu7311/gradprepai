import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

export interface PaymentRecord {
  id: string;
  source: 'upi' | 'razorpay';
  amount: number;           // in INR
  currency: string;
  plan: string;
  status: string;
  reference: string;        // upi_reference OR razorpay_payment_id
  payment_id: string | null;
  starts_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export function usePaymentHistory() {
  const { user } = useAuth();
  const [records, setRecords] = useState<PaymentRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!user) { setRecords([]); return; }

    const load = async () => {
      setLoading(true);
      setError(null);

      const [upiRes, rzpRes] = await Promise.all([
        supabase
          .from('upi_payments')
          .select('id, amount, currency, plan, status, upi_reference, starts_at, expires_at, created_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(20),
        supabase
          .from('razorpay_payments')
          .select('id, amount_paise, currency, plan, status, razorpay_payment_id, razorpay_order_id, starts_at, expires_at, created_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(20),
      ]);

      if (upiRes.error)  { setError(upiRes.error.message);  setLoading(false); return; }
      if (rzpRes.error)  { setError(rzpRes.error.message);  setLoading(false); return; }

      const upiRecords: PaymentRecord[] = (upiRes.data ?? []).map((r) => ({
        id:         r.id,
        source:     'upi',
        amount:     Number(r.amount),
        currency:   r.currency ?? 'INR',
        plan:       r.plan,
        status:     r.status === 'approved' ? 'paid' : r.status,
        reference:  r.upi_reference,
        payment_id: null,
        starts_at:  r.starts_at,
        expires_at: r.expires_at,
        created_at: r.created_at,
      }));

      const rzpRecords: PaymentRecord[] = (rzpRes.data ?? []).map((r) => ({
        id:         r.id,
        source:     'razorpay',
        amount:     Math.round(Number(r.amount_paise) / 100),
        currency:   r.currency ?? 'INR',
        plan:       r.plan,
        status:     r.status,           // 'created' | 'paid' | 'failed'
        reference:  r.razorpay_payment_id ?? r.razorpay_order_id,
        payment_id: r.razorpay_payment_id ?? null,
        starts_at:  r.starts_at,
        expires_at: r.expires_at,
        created_at: r.created_at,
      }));

      // Merge and sort descending by created_at
      const all = [...upiRecords, ...rzpRecords].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );

      setRecords(all);
      setLoading(false);
    };

    load();
  }, [user]);

  return { records, loading, error };
}
