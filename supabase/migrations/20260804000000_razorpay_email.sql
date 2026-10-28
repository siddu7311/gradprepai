-- =============================================================================
-- GradPrep AI — Razorpay payments + email jobs
-- Additive migration: does NOT alter or drop any existing table.
-- Safe to re-run (all CREATE statements use IF NOT EXISTS / DO $$ guards).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. razorpay_payments
--    One row per Razorpay order.  status progresses:
--      created → paid → failed | cancelled
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.razorpay_payments (
    id                  uuid        DEFAULT gen_random_uuid() NOT NULL,
    user_id             uuid        NOT NULL,
    email               text,

    -- Razorpay identifiers
    razorpay_order_id   text        NOT NULL,
    razorpay_payment_id text,
    razorpay_signature  text,

    -- Order details (server-controlled — never trusted from client)
    amount_paise        integer     NOT NULL,   -- amount in paise (19900 = ₹199)
    currency            text        NOT NULL DEFAULT 'INR',
    plan                text        NOT NULL DEFAULT 'pro',

    -- Lifecycle
    status              text        NOT NULL DEFAULT 'created',
    -- 'created' | 'paid' | 'failed' | 'cancelled'

    -- Pro access window granted on successful payment
    starts_at           timestamptz,
    expires_at          timestamptz,

    -- Webhook deduplication
    last_webhook_event  text,
    last_webhook_at     timestamptz,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Primary key
DO $$ BEGIN
  ALTER TABLE ONLY public.razorpay_payments ADD CONSTRAINT razorpay_payments_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL; END $$;

-- Unique on Razorpay order ID (prevent duplicate order rows)
DO $$ BEGIN
  ALTER TABLE ONLY public.razorpay_payments
    ADD CONSTRAINT razorpay_payments_order_id_key UNIQUE (razorpay_order_id);
EXCEPTION WHEN others THEN NULL; END $$;

-- FK to auth.users
DO $$ BEGIN
  ALTER TABLE ONLY public.razorpay_payments
    ADD CONSTRAINT razorpay_payments_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL; END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_razorpay_payments_user
  ON public.razorpay_payments (user_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_razorpay_payments_order
  ON public.razorpay_payments (razorpay_order_id);

-- updated_at trigger
DROP TRIGGER IF EXISTS update_razorpay_payments_updated_at ON public.razorpay_payments;
CREATE TRIGGER update_razorpay_payments_updated_at
  BEFORE UPDATE ON public.razorpay_payments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- RLS
ALTER TABLE public.razorpay_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own razorpay payments"  ON public.razorpay_payments;
DROP POLICY IF EXISTS "Admins can view all razorpay payments"       ON public.razorpay_payments;
DROP POLICY IF EXISTS "Service role can write razorpay payments"    ON public.razorpay_payments;

CREATE POLICY "Users can view their own razorpay payments"
  ON public.razorpay_payments FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all razorpay payments"
  ON public.razorpay_payments FOR SELECT
  TO authenticated
  USING (app_private.current_user_is_admin());

-- Edge Functions use service_role key — no explicit policy needed for service_role.
-- Grant SELECT to authenticated for the above policies to work.
GRANT SELECT ON public.razorpay_payments TO authenticated;
GRANT ALL    ON public.razorpay_payments TO service_role;


-- ---------------------------------------------------------------------------
-- 2. webhook_events
--    Idempotency table — one row per processed Razorpay webhook event.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.webhook_events (
    id              uuid    DEFAULT gen_random_uuid() NOT NULL,
    event_id        text    NOT NULL,   -- Razorpay X-Razorpay-Event-Id header
    event_type      text    NOT NULL,   -- e.g. 'payment.captured'
    payload_summary text,               -- small non-sensitive excerpt for debugging
    processed_at    timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE ONLY public.webhook_events ADD CONSTRAINT webhook_events_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY public.webhook_events
    ADD CONSTRAINT webhook_events_event_id_key UNIQUE (event_id);
EXCEPTION WHEN others THEN NULL; END $$;

-- No RLS needed — only service_role writes here.
GRANT ALL ON public.webhook_events TO service_role;


-- ---------------------------------------------------------------------------
-- 3. email_jobs
--    One row per queued/sent transactional email.
--    Prevents duplicate sends (idempotency_key unique constraint).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_jobs (
    id               uuid    DEFAULT gen_random_uuid() NOT NULL,
    user_id          uuid    NOT NULL,
    recipient_email  text    NOT NULL,
    email_type       text    NOT NULL,
    -- 'interview_result' | 'weekly_report' | 'payment_receipt'

    idempotency_key  text    NOT NULL,
    -- e.g. 'interview_result:{session_id}' or 'weekly:{user_id}:2025-W01'

    status           text    NOT NULL DEFAULT 'pending',
    -- 'pending' | 'sent' | 'failed' | 'skipped'

    provider_message_id  text,          -- Resend message ID
    error_message        text,          -- last error if failed
    attempt_count        integer NOT NULL DEFAULT 0,
    scheduled_for        timestamptz NOT NULL DEFAULT now(),
    sent_at              timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE ONLY public.email_jobs ADD CONSTRAINT email_jobs_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY public.email_jobs
    ADD CONSTRAINT email_jobs_idempotency_key_key UNIQUE (idempotency_key);
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY public.email_jobs
    ADD CONSTRAINT email_jobs_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_email_jobs_user
  ON public.email_jobs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_jobs_status
  ON public.email_jobs (status, scheduled_for);

DROP TRIGGER IF EXISTS update_email_jobs_updated_at ON public.email_jobs;
CREATE TRIGGER update_email_jobs_updated_at
  BEFORE UPDATE ON public.email_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.email_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own email jobs" ON public.email_jobs;
CREATE POLICY "Users can view their own email jobs"
  ON public.email_jobs FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

GRANT SELECT ON public.email_jobs TO authenticated;
GRANT ALL    ON public.email_jobs TO service_role;
