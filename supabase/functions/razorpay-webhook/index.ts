/**
 * razorpay-webhook
 *
 * POST (public — verified by HMAC signature)
 *
 * Handles: payment.captured, payment.failed
 *
 * Required secret: RAZORPAY_WEBHOOK_SECRET
 *
 * Webhook URL (configure in Razorpay Dashboard):
 *   https://uejhcakkxhbifsjhhfvy.supabase.co/functions/v1/razorpay-webhook
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-razorpay-signature",
};

const PRO_DAYS    = 30;
const AMOUNT_PAISE = 19900;
const CURRENCY     = "INR";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const WEBHOOK_SECRET = Deno.env.get("RAZORPAY_WEBHOOK_SECRET");
  if (!WEBHOOK_SECRET) {
    console.error("[razorpay-webhook] RAZORPAY_WEBHOOK_SECRET not configured");
    return ack(); // acknowledge to prevent Razorpay retries, log the misconfiguration
  }

  // ── Read raw body (required for signature verification) ───────────────────
  const rawBody = await req.text();

  // ── Verify webhook signature ──────────────────────────────────────────────
  const incomingSig = req.headers.get("x-razorpay-signature") ?? "";
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sigBytes  = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const expectedSig = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (!timingSafeEqual(expectedSig, incomingSig)) {
    console.warn("[razorpay-webhook] Invalid signature — rejecting");
    return new Response("Invalid signature", { status: 400 });
  }

  // ── Parse event ───────────────────────────────────────────────────────────
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const eventId   = (event.id ?? event.event_id ?? "") as string;
  const eventType = (event.event ?? "") as string;

  console.log(`[razorpay-webhook] event=${eventType} id=${eventId}`);

  if (!eventId || !eventType) {
    console.warn("[razorpay-webhook] Missing event id or type");
    return ack();
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  // ── Idempotency — reject already-processed events ─────────────────────────
  const { error: idempotErr } = await supabase.from("webhook_events").insert({
    event_id:        eventId,
    event_type:      eventType,
    payload_summary: `order=${getPath(event, "payload.payment.entity.order_id")}`,
  });

  if (idempotErr?.code === "23505") {
    // unique_violation — already processed
    console.log(`[razorpay-webhook] Duplicate event ${eventId} — skipping`);
    return ack();
  }

  // ── Handle events ─────────────────────────────────────────────────────────
  try {
    if (eventType === "payment.captured") {
      await handlePaymentCaptured(supabase, event);
    } else if (eventType === "payment.failed") {
      await handlePaymentFailed(supabase, event);
    } else {
      console.log(`[razorpay-webhook] Unhandled event type: ${eventType}`);
    }
  } catch (err) {
    console.error(`[razorpay-webhook] Error processing ${eventType}:`, err);
    // Do NOT update webhook_events row — allow Razorpay to retry
    await supabase.from("webhook_events")
      .delete().eq("event_id", eventId);
    return new Response("Internal error", { status: 500 });
  }

  return ack();
});

// ────────────────────────────────────────────────────────────────────────────

async function handlePaymentCaptured(
  supabase: ReturnType<typeof createClient>,
  event: Record<string, unknown>,
) {
  const payment  = getPath(event, "payload.payment.entity") as Record<string, unknown> | null;
  if (!payment) return;

  const orderId    = payment.order_id as string;
  const paymentId  = payment.id as string;
  const amount     = payment.amount as number;
  const currency   = payment.currency as string;

  if (amount !== AMOUNT_PAISE || currency !== CURRENCY) {
    console.error(`[razorpay-webhook] Amount/currency mismatch: ${amount} ${currency}`);
    return;
  }

  const { data: row } = await supabase
    .from("razorpay_payments")
    .select("id, user_id, status")
    .eq("razorpay_order_id", orderId)
    .maybeSingle();

  if (!row) {
    console.warn(`[razorpay-webhook] No DB row for order ${orderId}`);
    return;
  }

  if (row.status === "paid") {
    console.log(`[razorpay-webhook] Order ${orderId} already paid — skipping activation`);
    return;
  }

  const now       = new Date();
  const expiresAt = new Date(now.getTime() + PRO_DAYS * 24 * 60 * 60 * 1000);

  await supabase.from("razorpay_payments").update({
    razorpay_payment_id: paymentId,
    status:              "paid",
    starts_at:           now.toISOString(),
    expires_at:          expiresAt.toISOString(),
    last_webhook_event:  "payment.captured",
    last_webhook_at:     now.toISOString(),
  }).eq("razorpay_order_id", orderId);

  // Queue payment receipt email if not already queued
  await supabase.from("email_jobs").upsert({
    user_id:         row.user_id,
    recipient_email: (await getUserEmail(supabase, row.user_id)) ?? "",
    email_type:      "payment_receipt",
    idempotency_key: `payment_receipt:${orderId}`,
    status:          "pending",
    scheduled_for:   now.toISOString(),
  }, { onConflict: "idempotency_key", ignoreDuplicates: true });

  console.log(`[razorpay-webhook] Pro activated for user ${row.user_id} until ${expiresAt.toISOString()}`);
}

async function handlePaymentFailed(
  supabase: ReturnType<typeof createClient>,
  event: Record<string, unknown>,
) {
  const payment = getPath(event, "payload.payment.entity") as Record<string, unknown> | null;
  if (!payment) return;

  const orderId = payment.order_id as string;
  if (!orderId) return;

  await supabase.from("razorpay_payments").update({
    status:             "failed",
    last_webhook_event: "payment.failed",
    last_webhook_at:    new Date().toISOString(),
  }).eq("razorpay_order_id", orderId).eq("status", "created");

  console.log(`[razorpay-webhook] Payment failed for order ${orderId}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ack() {
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Navigate a dot-separated path into a nested object. */
function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

async function getUserEmail(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase.auth.admin.getUserById(userId);
  return data?.user?.email ?? null;
}
