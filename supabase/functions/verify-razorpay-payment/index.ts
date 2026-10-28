/**
 * verify-razorpay-payment
 *
 * POST (authenticated)
 * Body: {
 *   razorpay_order_id:   string,
 *   razorpay_payment_id: string,
 *   razorpay_signature:  string
 * }
 *
 * Returns: { success: true, expires_at: string } | { error: string }
 *
 * Required secrets: RAZORPAY_KEY_SECRET
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const AMOUNT_PAISE = 19900;
const CURRENCY     = "INR";
const PRO_DAYS     = 30;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);
    const { data: { user }, error: authErr } =
      await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    // ── Parse body ────────────────────────────────────────────────────────────
    const body = await req.json().catch(() => null);
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body ?? {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return json({ error: "Missing payment fields" }, 400);
    }

    // ── Secrets ───────────────────────────────────────────────────────────────
    const KEY_ID = Deno.env.get("RAZORPAY_KEY_ID");
    const KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET");
    if (!KEY_ID || !KEY_SECRET) return json({ error: "Payment service not configured" }, 503);

    // ── Verify HMAC-SHA256 signature ──────────────────────────────────────────
    // Razorpay signing payload: "<order_id>|<payment_id>"
    const signingPayload = `${razorpay_order_id}|${razorpay_payment_id}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(KEY_SECRET);
    const msgData = encoder.encode(signingPayload);

    const cryptoKey = await crypto.subtle.importKey(
      "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const signatureBytes = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
    const expectedSig = Array.from(new Uint8Array(signatureBytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Constant-time compare
    if (!timingSafeEqual(expectedSig, razorpay_signature)) {
      console.warn(`[verify-razorpay-payment] Signature mismatch for order ${razorpay_order_id}`);
      return json({ error: "Payment verification failed: invalid signature" }, 400);
    }

    // ── Confirm order belongs to this user and is in correct state ────────────
    const { data: payRow, error: payErr } = await supabase
      .from("razorpay_payments")
      .select("id, user_id, amount_paise, currency, status")
      .eq("razorpay_order_id", razorpay_order_id)
      .maybeSingle();

    if (payErr || !payRow) {
      console.error("[verify-razorpay-payment] Order not found:", razorpay_order_id);
      return json({ error: "Order not found" }, 404);
    }

    if (payRow.user_id !== user.id) {
      console.warn(`[verify-razorpay-payment] User mismatch: expected ${payRow.user_id} got ${user.id}`);
      return json({ error: "Unauthorized" }, 403);
    }

    if (payRow.status === "paid") {
      // Already processed — return existing expiry idempotently.
      const { data: existing } = await supabase
        .from("razorpay_payments")
        .select("expires_at")
        .eq("razorpay_order_id", razorpay_order_id)
        .single();
      return json({ success: true, expires_at: existing?.expires_at, already_active: true });
    }

    if (payRow.status !== "created") {
      return json({ error: `Order is in state '${payRow.status}' — cannot verify` }, 409);
    }

    // ── Verify amount and currency server-side against Razorpay ──────────────
    let orderRes: Response;
    try {
      orderRes = await fetch(`https://api.razorpay.com/v1/orders/${razorpay_order_id}`, {
        headers: { Authorization: `Basic ${btoa(`${KEY_ID}:${KEY_SECRET}`)}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (fetchErr) {
      console.error("[verify-razorpay-payment] Could not reach Razorpay API:", fetchErr);
      return json({ error: "Could not confirm payment with Razorpay. Please try again." }, 502);
    }

    if (!orderRes.ok) {
      const errText = await orderRes.text();
      console.error(`[verify-razorpay-payment] Razorpay API error ${orderRes.status}:`, errText.slice(0, 200));
      return json({ error: "Could not confirm payment with Razorpay. Please try again." }, 502);
    }

    const orderData = await orderRes.json();
    if (orderData.amount !== AMOUNT_PAISE || orderData.currency !== CURRENCY) {
      console.error("[verify-razorpay-payment] Amount/currency mismatch", orderData);
      return json({ error: "Order amount or currency mismatch" }, 400);
    }
    if (orderData.status !== "paid") {
      console.warn("[verify-razorpay-payment] Razorpay order not yet paid:", orderData.status);
      // Signature was valid but payment not confirmed — mark pending, let webhook finalize.
      await supabase.from("razorpay_payments").update({
        razorpay_payment_id,
        razorpay_signature,
      }).eq("razorpay_order_id", razorpay_order_id);
      return json({ success: false, pending: true, message: "Payment is being confirmed. Check back shortly." });
    }

    // ── Activate Pro ─────────────────────────────────────────────────────────
    const now       = new Date();
    const expiresAt = new Date(now.getTime() + PRO_DAYS * 24 * 60 * 60 * 1000);

    const { error: updateErr } = await supabase
      .from("razorpay_payments")
      .update({
        razorpay_payment_id,
        razorpay_signature,
        status:     "paid",
        starts_at:  now.toISOString(),
        expires_at: expiresAt.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("razorpay_order_id", razorpay_order_id);

    if (updateErr) {
      console.error("[verify-razorpay-payment] DB update error:", updateErr.message);
      return json({ error: "Failed to activate Pro. Please contact support." }, 500);
    }

    // ── Queue payment receipt email (ignore if already queued) ────────────────
    await supabase.from("email_jobs").upsert({
      user_id:         user.id,
      recipient_email: user.email ?? "",
      email_type:      "payment_receipt",
      idempotency_key: `payment_receipt:${razorpay_order_id}`,
      status:          "pending",
      scheduled_for:   now.toISOString(),
    }, { onConflict: "idempotency_key", ignoreDuplicates: true });

    console.log(`[verify-razorpay-payment] Pro activated for user ${user.id} until ${expiresAt.toISOString()}`);

    return json({ success: true, expires_at: expiresAt.toISOString() });
  } catch (err) {
    console.error("[verify-razorpay-payment] unhandled:", err);
    return json({ error: "Unexpected error" }, 500);
  }
});

/** Constant-time string comparison to prevent timing attacks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
