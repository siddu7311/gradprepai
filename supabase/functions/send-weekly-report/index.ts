/**
 * send-weekly-report — Weekly progress email for opted-in users
 *
 * Invoked by pg_cron every Monday at 08:00 UTC via:
 *   SELECT net.http_post(
 *     url := 'https://<ref>.supabase.co/functions/v1/send-weekly-report',
 *     headers := '{"Authorization":"Bearer <service_role_key>","Content-Type":"application/json"}',
 *     body := '{}'
 *   );
 *
 * For each user with notification_weekly_summary = true, queries their last-7-day
 * interview stats and fires send-email with an HTML summary.
 *
 * Required secrets: RESEND_API_KEY, EMAIL_FROM
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Only service-role callers (pg_cron) should trigger this
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const FROM_ADDRESS   = Deno.env.get("EMAIL_FROM") ?? "GradPrep AI <onboarding@resend.dev>";
  const SUPABASE_URL   = Deno.env.get("SUPABASE_URL") ?? "";

  if (!RESEND_API_KEY) {
    console.error("[send-weekly-report] RESEND_API_KEY not configured");
    return json({ error: "Email service not configured" }, 503);
  }

  try {
    const now       = new Date();
    const weekAgo   = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const weekLabel = `${weekAgo.toISOString().slice(0, 10)} – ${now.toISOString().slice(0, 10)}`;

    // ── Fetch opted-in users ──────────────────────────────────────────────────
    const { data: profiles, error: profileErr } = await supabase
      .from("profiles")
      .select("user_id, display_name, email")
      .eq("notification_weekly_summary", true)
      .not("email", "is", null);

    if (profileErr) {
      console.error("[send-weekly-report] profiles query failed:", profileErr.message);
      return json({ error: "DB query failed" }, 500);
    }

    if (!profiles || profiles.length === 0) {
      console.log("[send-weekly-report] No opted-in users");
      return json({ success: true, sent: 0 });
    }

    let sent = 0;
    let skipped = 0;

    for (const profile of profiles) {
      try {
        const idempotency_key = `weekly_report:${profile.user_id}:${weekAgo.toISOString().slice(0, 10)}`;

        // ── Idempotency: skip if already sent this week ───────────────────────
        const { data: existingJob } = await supabase
          .from("email_jobs")
          .select("id, status")
          .eq("idempotency_key", idempotency_key)
          .maybeSingle();

        if (existingJob?.status === "sent") {
          skipped++;
          continue;
        }

        // ── Gather this user's last-7-day stats ───────────────────────────────
        const { data: sessions } = await supabase
          .from("interview_sessions")
          .select("id, role_type, difficulty, overall_score, completed_questions, completed_at, status")
          .eq("user_id", profile.user_id)
          .eq("status", "completed")
          .gte("completed_at", weekAgo.toISOString())
          .order("completed_at", { ascending: false });

        const sessionList = sessions ?? [];
        const totalInterviews = sessionList.length;

        if (totalInterviews === 0) {
          // No activity this week — skip (don't spam inactive users)
          skipped++;
          continue;
        }

        const avgScore = totalInterviews > 0
          ? Math.round(
              sessionList.reduce((s, r) => s + (r.overall_score ?? 0), 0) / totalInterviews,
            )
          : 0;

        const bestSession = sessionList.reduce(
          (best, s) => (s.overall_score ?? 0) > (best.overall_score ?? 0) ? s : best,
          sessionList[0],
        );

        // ── Build HTML email ──────────────────────────────────────────────────
        const displayName = profile.display_name ?? "there";
        const sessionRows = sessionList.slice(0, 5).map((s) => `
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${s.role_type}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-transform:capitalize;">${s.difficulty}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;">${s.overall_score ?? "—"}%</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;">${s.completed_questions}</td>
          </tr>`).join("");

        const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#6366f1 0%,#4f46e5 100%);padding:32px 40px;text-align:center;">
      <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;">GradPrep AI</h1>
      <p style="margin:8px 0 0;color:#c7d2fe;font-size:14px;">Your Weekly Progress Report</p>
    </div>

    <!-- Body -->
    <div style="padding:32px 40px;">
      <p style="margin:0 0 8px;font-size:16px;color:#1f2937;">Hi ${displayName},</p>
      <p style="margin:0 0 24px;color:#6b7280;font-size:14px;">Here's a summary of your interview practice for <strong>${weekLabel}</strong>.</p>

      <!-- Stats row -->
      <div style="display:flex;gap:16px;margin-bottom:28px;">
        <div style="flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;text-align:center;">
          <div style="font-size:28px;font-weight:700;color:#4f46e5;">${totalInterviews}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:4px;">Interviews</div>
        </div>
        <div style="flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;text-align:center;">
          <div style="font-size:28px;font-weight:700;color:#059669;">${avgScore}%</div>
          <div style="font-size:12px;color:#6b7280;margin-top:4px;">Avg Score</div>
        </div>
        <div style="flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;text-align:center;">
          <div style="font-size:28px;font-weight:700;color:#d97706;">${bestSession.overall_score ?? "—"}%</div>
          <div style="font-size:12px;color:#6b7280;margin-top:4px;">Best Score</div>
        </div>
      </div>

      ${sessionList.length > 0 ? `
      <!-- Session table -->
      <h3 style="margin:0 0 12px;font-size:15px;color:#1f2937;">Recent Sessions</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;color:#374151;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:10px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e7eb;">Role</th>
            <th style="padding:10px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e7eb;">Difficulty</th>
            <th style="padding:10px 12px;text-align:center;font-weight:600;border-bottom:2px solid #e5e7eb;">Score</th>
            <th style="padding:10px 12px;text-align:center;font-weight:600;border-bottom:2px solid #e5e7eb;">Qs</th>
          </tr>
        </thead>
        <tbody>${sessionRows}</tbody>
      </table>
      ${sessionList.length > 5 ? `<p style="margin:8px 0 0;font-size:12px;color:#9ca3af;">…and ${sessionList.length - 5} more sessions</p>` : ""}
      ` : ""}

      <!-- CTA -->
      <div style="margin-top:28px;text-align:center;">
        <a href="https://gradprepai.com/interview"
           style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:600;">
          Practice This Week →
        </a>
      </div>
    </div>

    <!-- Footer -->
    <div style="padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;">
      <p style="margin:0;font-size:12px;color:#9ca3af;">
        You're receiving this because you opted in to weekly summaries.<br>
        <a href="https://gradprepai.com/settings" style="color:#6366f1;">Manage email preferences</a>
      </p>
    </div>
  </div>
</body>
</html>`;

        const text = `Hi ${displayName},\n\nYour GradPrep AI Weekly Report (${weekLabel})\n\nInterviews completed: ${totalInterviews}\nAverage score: ${avgScore}%\nBest score: ${bestSession.overall_score ?? "N/A"}%\n\nKeep practising at https://gradprepai.com/interview\n\nTo stop these emails, update your preferences at https://gradprepai.com/settings`;

        // ── Insert job row first (idempotency) ────────────────────────────────
        await supabase.from("email_jobs").upsert({
          user_id:         profile.user_id,
          recipient_email: profile.email,
          email_type:      "weekly_report",
          idempotency_key,
          status:          "pending",
          scheduled_for:   now.toISOString(),
          payload:         { week: weekAgo.toISOString().slice(0, 10), total_interviews: totalInterviews, avg_score: avgScore },
        }, { onConflict: "idempotency_key", ignoreDuplicates: true });

        // ── Send via Resend directly (avoid double-hop latency) ───────────────
        const resendRes = await fetch("https://api.resend.com/emails", {
          method:  "POST",
          headers: {
            "Authorization": `Bearer ${RESEND_API_KEY}`,
            "Content-Type":  "application/json",
          },
          body: JSON.stringify({
            from:    FROM_ADDRESS,
            to:      [profile.email],
            subject: `Your GradPrep AI Weekly Report — ${weekLabel}`,
            html,
            text,
          }),
        });

        const resendData = await resendRes.json();

        if (resendRes.ok) {
          await supabase.from("email_jobs").update({
            status:              "sent",
            provider_message_id: resendData.id ?? "",
            sent_at:             now.toISOString(),
            attempt_count:       1,
          }).eq("idempotency_key", idempotency_key);
          sent++;
        } else {
          console.error(`[send-weekly-report] Failed for ${profile.email}:`, resendData);
          await supabase.from("email_jobs").update({
            status:        "failed",
            error_message: JSON.stringify(resendData).slice(0, 500),
            attempt_count: 1,
          }).eq("idempotency_key", idempotency_key);
        }
      } catch (userErr) {
        console.error(`[send-weekly-report] Error for user ${profile.user_id}:`, userErr);
      }
    }

    console.log(`[send-weekly-report] Done — sent=${sent} skipped=${skipped} total_opted_in=${profiles.length}`);
    return json({ success: true, sent, skipped });
  } catch (err) {
    console.error("[send-weekly-report] unhandled:", err);
    return json({ error: "Unexpected error" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
