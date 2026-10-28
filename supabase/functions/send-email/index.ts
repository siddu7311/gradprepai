/**
 * send-email — Resend transactional email delivery
 *
 * POST (service_role only — called from other Edge Functions)
 * Body: {
 *   to:      string,
 *   subject: string,
 *   html:    string,
 *   text:    string,
 *   idempotency_key: string
 * }
 *
 * Required secret: RESEND_API_KEY
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FROM_ADDRESS = Deno.env.get("EMAIL_FROM") ?? "GradPrep AI <noreply@gradprepai.com>";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  if (!RESEND_API_KEY) {
    console.error("[send-email] RESEND_API_KEY not configured");
    return json({ error: "Email service not configured" }, 503);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    const body = await req.json().catch(() => null);
    const { to, subject, html, text, idempotency_key } = body ?? {};

    if (!to || !subject || (!html && !text)) {
      return json({ error: "Missing required fields: to, subject, html/text" }, 400);
    }

    // ── Idempotency check ─────────────────────────────────────────────────────
    if (idempotency_key) {
      const { data: existing } = await supabase
        .from("email_jobs")
        .select("id, status, provider_message_id")
        .eq("idempotency_key", idempotency_key)
        .maybeSingle();

      if (existing?.status === "sent") {
        console.log(`[send-email] Already sent: ${idempotency_key}`);
        return json({ success: true, already_sent: true, message_id: existing.provider_message_id });
      }
    }

    // ── Send via Resend ───────────────────────────────────────────────────────
    const resendBody: Record<string, unknown> = {
      from:    FROM_ADDRESS,
      to:      [to],
      subject,
    };
    if (html)  resendBody.html = html;
    if (text)  resendBody.text = text;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify(resendBody),
    });

    const resendData = await resendRes.json();

    if (!resendRes.ok) {
      console.error("[send-email] Resend error:", resendData);
      // Update job status if tracked
      if (idempotency_key) {
        await supabase.from("email_jobs").update({
          status:        "failed",
          error_message: JSON.stringify(resendData).slice(0, 500),
          attempt_count: 1,
        }).eq("idempotency_key", idempotency_key);
      }
      return json({ error: "Email delivery failed", detail: resendData }, 502);
    }

    const messageId = resendData.id ?? "";
    console.log(`[send-email] Sent to ${to} — message_id=${messageId}`);

    // ── Mark as sent ──────────────────────────────────────────────────────────
    if (idempotency_key) {
      await supabase.from("email_jobs").update({
        status:             "sent",
        provider_message_id: messageId,
        sent_at:            new Date().toISOString(),
        attempt_count:      1,
      }).eq("idempotency_key", idempotency_key);
    }

    return json({ success: true, message_id: messageId });
  } catch (err) {
    console.error("[send-email] unhandled:", err);
    return json({ error: "Unexpected error" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
