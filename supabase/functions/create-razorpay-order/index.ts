/**
 * create-razorpay-order
 *
 * POST (authenticated)
 * Body: { plan?: 'pro' }
 *
 * Returns: { key_id, order_id, amount, currency, name, description, prefill }
 *
 * Required secrets: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const AMOUNT_PAISE = 19900;   // ₹199 — never trust the client
const CURRENCY     = "INR";
const PLAN         = "pro";

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

    // ── Secrets ───────────────────────────────────────────────────────────────
    const KEY_ID     = Deno.env.get("RAZORPAY_KEY_ID");
    const KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET");
    if (!KEY_ID || !KEY_SECRET) {
      console.error("[create-razorpay-order] Razorpay secrets not configured");
      return json({ error: "Payment service not configured" }, 503);
    }

    // ── Check for an existing unpaid order (idempotency) ──────────────────────
    const { data: existing } = await supabase
      .from("razorpay_payments")
      .select("razorpay_order_id, status")
      .eq("user_id", user.id)
      .eq("status", "created")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let orderId: string;

    if (existing?.razorpay_order_id) {
      // Reuse the pending order instead of creating a duplicate charge.
      orderId = existing.razorpay_order_id;
      console.log(`[create-razorpay-order] Reusing existing order ${orderId} for user ${user.id}`);
    } else {
      // ── Create Razorpay order ─────────────────────────────────────────────
      const receipt = `gp_${user.id.slice(0, 8)}_${Date.now()}`;
      const rzpBody = JSON.stringify({
        amount:   AMOUNT_PAISE,
        currency: CURRENCY,
        receipt,
        notes: { user_id: user.id, plan: PLAN },
      });

      const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Basic ${btoa(`${KEY_ID}:${KEY_SECRET}`)}`,
        },
        body: rzpBody,
      });

      if (!rzpRes.ok) {
        const errText = await rzpRes.text();
        console.error(`[create-razorpay-order] Razorpay error ${rzpRes.status}:`, errText.slice(0, 300));
        return json({ error: "Could not create payment order. Please try again." }, 502);
      }

      const order = await rzpRes.json();
      orderId = order.id;

      // ── Persist to DB ─────────────────────────────────────────────────────
      const { error: dbErr } = await supabase.from("razorpay_payments").insert({
        user_id:           user.id,
        email:             user.email,
        razorpay_order_id: orderId,
        amount_paise:      AMOUNT_PAISE,
        currency:          CURRENCY,
        plan:              PLAN,
        status:            "created",
      });

      if (dbErr) {
        // If unique constraint fires (race condition), fall through with the order still valid.
        console.warn("[create-razorpay-order] DB insert warning:", dbErr.message);
      }

      console.log(`[create-razorpay-order] Created order ${orderId} for user ${user.id}`);
    }

    // ── Return public checkout data (Key Secret never leaves server) ──────────
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("user_id", user.id)
      .maybeSingle();

    return json({
      key_id:      KEY_ID,
      order_id:    orderId,
      amount:      AMOUNT_PAISE,
      currency:    CURRENCY,
      name:        "GradPrep AI",
      description: "Pro Plan — 30 days of unlimited interviews",
      prefill: {
        name:  profile?.display_name ?? "",
        email: user.email ?? "",
      },
    });
  } catch (err) {
    console.error("[create-razorpay-order] unhandled:", err);
    return json({ error: "Unexpected error" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
