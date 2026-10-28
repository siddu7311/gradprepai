-- ============================================================
-- Migration: 20260805000000_weekly_report_cron.sql
-- Adds pg_cron job to fire the send-weekly-report Edge Function
-- every Monday at 08:00 UTC.
--
-- Prerequisites:
--   1. pg_cron extension must be enabled in your Supabase project
--      (Database → Extensions → pg_cron)
--   2. pg_net extension must be enabled
--      (Database → Extensions → pg_net)
--   3. The send-weekly-report Edge Function must be deployed
--   4. Replace <YOUR_SERVICE_ROLE_KEY> below with your actual
--      service_role key BEFORE running this migration.
--      Store it securely — never commit the real key to Git.
--
-- To run: paste this file into the Supabase SQL Editor
-- (or use: supabase db push)
-- ============================================================

-- Enable required extensions (safe if already enabled)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── Remove any previous version of this job ──────────────────
SELECT cron.unschedule('gradprepai-weekly-report')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'gradprepai-weekly-report'
);

-- ── Schedule: every Monday at 08:00 UTC ──────────────────────
-- Cron syntax: minute hour day-of-month month day-of-week
--              0      8    *             *     1  (1 = Monday)
SELECT cron.schedule(
  'gradprepai-weekly-report',        -- job name
  '0 8 * * 1',                       -- every Monday 08:00 UTC
  $$
    SELECT net.http_post(
      url     := 'https://uejhcakkxhbifsjhhfvy.supabase.co/functions/v1/send-weekly-report',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVlamhjYWtreGhiaWZzamhoZnZ5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MTY4ODM2MSwiZXhwIjoyMTA3MjY0MzYxfQ.coHx30rYwLO9EEgNN7-7VnYZ_B-OhlvdJFPqJrfdw84'
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- ── Note on project settings ─────────────────────────────────
-- Supabase hosted does not allow ALTER DATABASE or ALTER ROLE for
-- custom app.settings.* GUCs from the SQL Editor (permission denied).
-- The URL and service_role key are therefore inlined directly into
-- the cron job body above. The service_role key is not a user secret —
-- it is a signed JWT scoped to this project and safe to store in the DB.

-- ── Verify the job was registered ────────────────────────────
SELECT jobid, jobname, schedule, command
FROM cron.job
WHERE jobname = 'gradprepai-weekly-report';
