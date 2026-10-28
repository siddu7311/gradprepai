-- =============================================================================
-- GradPrep AI — Full destination schema (IDEMPOTENT — safe to re-run)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pg_graphql"         WITH SCHEMA "graphql";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements"  WITH SCHEMA "extensions";
CREATE EXTENSION IF NOT EXISTS "pgcrypto"            WITH SCHEMA "extensions";
CREATE EXTENSION IF NOT EXISTS "supabase_vault"      WITH SCHEMA "vault";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp"           WITH SCHEMA "extensions";

-- ---------------------------------------------------------------------------
-- 2. Private schema
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL  ON SCHEMA app_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA app_private TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Enum (idempotent)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
    id                               uuid        DEFAULT gen_random_uuid() NOT NULL,
    user_id                          uuid        NOT NULL,
    display_name                     text,
    avatar_url                       text,
    email                            text,
    phone                            text,
    bio                              text,
    notification_email               boolean     DEFAULT true,
    notification_push                boolean     DEFAULT true,
    notification_interview_reminders boolean     DEFAULT true,
    notification_weekly_summary      boolean     DEFAULT true,
    theme_preference                 text        DEFAULT 'system',
    created_at  timestamptz DEFAULT now() NOT NULL,
    updated_at  timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.interview_sessions (
    id                  uuid        DEFAULT gen_random_uuid() NOT NULL,
    user_id             uuid        NOT NULL,
    role_type           text        NOT NULL,
    difficulty          text        DEFAULT 'intermediate' NOT NULL,
    experience_level    text,
    company_type        text,
    total_questions     integer     DEFAULT 0  NOT NULL,
    completed_questions integer     DEFAULT 0  NOT NULL,
    overall_score       numeric(5,2),
    duration_minutes    integer,
    status              text        DEFAULT 'in_progress' NOT NULL,
    started_at          timestamptz DEFAULT now() NOT NULL,
    completed_at        timestamptz,
    created_at          timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.interview_results (
    id                    uuid        DEFAULT gen_random_uuid() NOT NULL,
    session_id            uuid        NOT NULL,
    user_id               uuid        NOT NULL,
    question_number       integer     NOT NULL,
    question_text         text        NOT NULL,
    user_answer           text,
    ideal_answer          text,
    score                 numeric(5,2),
    strengths             text[],
    weaknesses            text[],
    technical_score       numeric(5,2),
    communication_score   numeric(5,2),
    problem_solving_score numeric(5,2),
    confidence_score      numeric(5,2),
    feedback              text,
    created_at            timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.schedules (
    id               uuid        DEFAULT gen_random_uuid() NOT NULL,
    user_id          uuid        NOT NULL,
    title            text        NOT NULL,
    description      text,
    event_type       text        DEFAULT 'meeting' NOT NULL,
    scheduled_at     timestamptz NOT NULL,
    reminder_minutes integer     DEFAULT 15,
    notified         boolean     DEFAULT false,
    created_at       timestamptz DEFAULT now() NOT NULL,
    updated_at       timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.user_roles (
    id         uuid            DEFAULT gen_random_uuid() NOT NULL,
    user_id    uuid            NOT NULL,
    role       public.app_role NOT NULL DEFAULT 'user',
    created_at timestamptz     DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.enterprise_requests (
    id           uuid        DEFAULT gen_random_uuid() NOT NULL,
    user_id      uuid        NOT NULL,
    user_email   text        NOT NULL,
    user_name    text,
    organization text,
    message      text,
    status       text        NOT NULL DEFAULT 'pending',
    created_at   timestamptz DEFAULT now() NOT NULL,
    updated_at   timestamptz DEFAULT now() NOT NULL,
    reviewed_by  uuid,
    reviewed_at  timestamptz
);

CREATE TABLE IF NOT EXISTS public.upi_payments (
    id            uuid        DEFAULT gen_random_uuid() NOT NULL,
    user_id       uuid        NOT NULL,
    email         text,
    amount        numeric     NOT NULL DEFAULT 199,
    currency      text        NOT NULL DEFAULT 'INR',
    plan          text        NOT NULL DEFAULT 'pro',
    upi_reference text        NOT NULL,
    payer_phone   text,
    status        text        NOT NULL DEFAULT 'approved',
    starts_at     timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 5. Primary keys (idempotent)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE ONLY public.profiles            ADD CONSTRAINT profiles_pkey            PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY public.interview_sessions  ADD CONSTRAINT interview_sessions_pkey  PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY public.interview_results   ADD CONSTRAINT interview_results_pkey   PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY public.schedules           ADD CONSTRAINT schedules_pkey           PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY public.user_roles          ADD CONSTRAINT user_roles_pkey          PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY public.enterprise_requests ADD CONSTRAINT enterprise_requests_pkey PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY public.upi_payments        ADD CONSTRAINT upi_payments_pkey        PRIMARY KEY (id);
EXCEPTION WHEN others THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 6. Unique constraints (idempotent)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE ONLY public.profiles   ADD CONSTRAINT profiles_user_id_key         UNIQUE (user_id);
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY public.user_roles ADD CONSTRAINT user_roles_user_id_role_key  UNIQUE (user_id, role);
EXCEPTION WHEN others THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 7. Foreign keys (idempotent)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE ONLY public.profiles ADD CONSTRAINT profiles_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY public.interview_sessions ADD CONSTRAINT interview_sessions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY public.interview_results ADD CONSTRAINT interview_results_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY public.interview_results ADD CONSTRAINT interview_results_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES public.interview_sessions(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY public.user_roles ADD CONSTRAINT user_roles_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY public.upi_payments ADD CONSTRAINT upi_payments_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 8. Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_upi_payments_user ON public.upi_payments (user_id, expires_at DESC);

-- ---------------------------------------------------------------------------
-- 9. Database functions (CREATE OR REPLACE — always idempotent)
-- ---------------------------------------------------------------------------

-- Auto-create profile on new user sign-up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(
      NEW.raw_user_meta_data ->> 'display_name',
      NEW.raw_user_meta_data ->> 'full_name',
      split_part(NEW.email, '@', 1)
    )
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Keep updated_at current
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Role check
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role
  );
$$;

-- Admin check convenience function
CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = 'admin'
  );
$$;

-- Private admin helper (not exposed as RPC — prevents policy recursion)
CREATE OR REPLACE FUNCTION app_private.current_user_is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = (SELECT auth.uid()) AND role = 'admin'::public.app_role
  );
$$;

-- ---------------------------------------------------------------------------
-- 10. Function permission hardening
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.handle_new_user()                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column()        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role)   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.is_admin(uuid)                    FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_admin(uuid)                    TO authenticated;
REVOKE ALL     ON FUNCTION app_private.current_user_is_admin()      FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION app_private.current_user_is_admin()      TO authenticated;

-- ---------------------------------------------------------------------------
-- 11. Triggers (drop-then-create = idempotent)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS on_auth_user_created                    ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

DROP TRIGGER IF EXISTS update_profiles_updated_at              ON public.profiles;
CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_schedules_updated_at             ON public.schedules;
CREATE TRIGGER update_schedules_updated_at
  BEFORE UPDATE ON public.schedules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_enterprise_requests_updated_at   ON public.enterprise_requests;
CREATE TRIGGER update_enterprise_requests_updated_at
  BEFORE UPDATE ON public.enterprise_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 12. Enable Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interview_sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interview_results    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedules            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enterprise_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upi_payments         ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 13. RLS Policies (drop-then-create = idempotent)
-- ---------------------------------------------------------------------------

-- profiles
DROP POLICY IF EXISTS "Users can view their own profile"  ON public.profiles;
DROP POLICY IF EXISTS "Users can create their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Admins can view all profiles"       ON public.profiles;

CREATE POLICY "Users can view their own profile"
  ON public.profiles FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own profile"
  ON public.profiles FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all profiles"
  ON public.profiles FOR SELECT TO authenticated
  USING (app_private.current_user_is_admin());

-- interview_sessions
DROP POLICY IF EXISTS "Users can view their own interview sessions"   ON public.interview_sessions;
DROP POLICY IF EXISTS "Users can create their own interview sessions" ON public.interview_sessions;
DROP POLICY IF EXISTS "Users can update their own interview sessions" ON public.interview_sessions;

CREATE POLICY "Users can view their own interview sessions"
  ON public.interview_sessions FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own interview sessions"
  ON public.interview_sessions FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own interview sessions"
  ON public.interview_sessions FOR UPDATE USING (auth.uid() = user_id);

-- interview_results
DROP POLICY IF EXISTS "Users can view their own interview results"   ON public.interview_results;
DROP POLICY IF EXISTS "Users can create their own interview results" ON public.interview_results;
DROP POLICY IF EXISTS "Users can update their own interview results" ON public.interview_results;

CREATE POLICY "Users can view their own interview results"
  ON public.interview_results FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own interview results"
  ON public.interview_results FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own interview results"
  ON public.interview_results FOR UPDATE USING (auth.uid() = user_id);

-- schedules
DROP POLICY IF EXISTS "Users can view their own schedules"   ON public.schedules;
DROP POLICY IF EXISTS "Users can create their own schedules" ON public.schedules;
DROP POLICY IF EXISTS "Users can update their own schedules" ON public.schedules;
DROP POLICY IF EXISTS "Users can delete their own schedules" ON public.schedules;

CREATE POLICY "Users can view their own schedules"
  ON public.schedules FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own schedules"
  ON public.schedules FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own schedules"
  ON public.schedules FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own schedules"
  ON public.schedules FOR DELETE USING (auth.uid() = user_id);

-- user_roles
DROP POLICY IF EXISTS "Users can view their own roles" ON public.user_roles;
DROP POLICY IF EXISTS "Admins can view all roles"      ON public.user_roles;
DROP POLICY IF EXISTS "Admins can insert roles"        ON public.user_roles;
DROP POLICY IF EXISTS "Admins can update roles"        ON public.user_roles;
DROP POLICY IF EXISTS "Admins can delete roles"        ON public.user_roles;

CREATE POLICY "Users can view their own roles"
  ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all roles"
  ON public.user_roles FOR SELECT TO authenticated USING (app_private.current_user_is_admin());

CREATE POLICY "Admins can insert roles"
  ON public.user_roles FOR INSERT TO authenticated WITH CHECK (app_private.current_user_is_admin());

CREATE POLICY "Admins can update roles"
  ON public.user_roles FOR UPDATE TO authenticated USING (app_private.current_user_is_admin());

CREATE POLICY "Admins can delete roles"
  ON public.user_roles FOR DELETE TO authenticated USING (app_private.current_user_is_admin());

-- enterprise_requests
DROP POLICY IF EXISTS "Users can create their own requests" ON public.enterprise_requests;
DROP POLICY IF EXISTS "Users can view their own requests"   ON public.enterprise_requests;
DROP POLICY IF EXISTS "Admins can view all requests"        ON public.enterprise_requests;
DROP POLICY IF EXISTS "Admins can update requests"          ON public.enterprise_requests;

CREATE POLICY "Users can create their own requests"
  ON public.enterprise_requests FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view their own requests"
  ON public.enterprise_requests FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all requests"
  ON public.enterprise_requests FOR SELECT USING (app_private.current_user_is_admin());

CREATE POLICY "Admins can update requests"
  ON public.enterprise_requests FOR UPDATE USING (app_private.current_user_is_admin());

-- upi_payments
DROP POLICY IF EXISTS "Users can view their own payments" ON public.upi_payments;
DROP POLICY IF EXISTS "Admins can view all payments"      ON public.upi_payments;

CREATE POLICY "Users can view their own payments"
  ON public.upi_payments FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all payments"
  ON public.upi_payments FOR SELECT TO authenticated USING (app_private.current_user_is_admin());

-- ---------------------------------------------------------------------------
-- 14. Grants
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.upi_payments TO authenticated;
GRANT ALL    ON public.upi_payments TO service_role;

-- ---------------------------------------------------------------------------
-- 15. Storage bucket for avatars
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Users can list their own avatar files" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload their own avatar"     ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own avatar"     ON storage.objects;

CREATE POLICY "Users can list their own avatar files"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'avatars' AND (auth.uid())::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can upload their own avatar"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND (auth.uid())::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can update their own avatar"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars' AND (auth.uid())::text = (storage.foldername(name))[1]);
