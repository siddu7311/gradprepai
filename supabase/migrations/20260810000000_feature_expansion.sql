-- =============================================================================
-- GradPrep AI — Feature Expansion: Custom Interviews, ATS Analyzer, Aptitude
-- Backward-compatible additive migration — never drops existing tables/data.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- MODULE 1: Custom Interview Questions
-- ---------------------------------------------------------------------------

-- Uploaded document records (private per-user by default)
CREATE TABLE IF NOT EXISTS public.custom_question_sets (
    id                  uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id             uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title               text        NOT NULL,
    description         text,
    source_file_path    text,           -- Storage bucket path
    source_file_name    text,
    source_file_type    text,
    extracted_text      text,
    processing_status   text        NOT NULL DEFAULT 'pending',  -- pending|processing|ready|error
    processing_error    text,
    target_role         text,
    subject             text,
    difficulty          text        DEFAULT 'intermediate',
    language            text        DEFAULT 'English',
    is_archived         boolean     NOT NULL DEFAULT false,
    is_admin_set        boolean     NOT NULL DEFAULT false,       -- true = global admin bank
    is_published        boolean     NOT NULL DEFAULT false,       -- admin sets only
    visibility          text        DEFAULT 'private',           -- private|public|selected
    available_from      timestamptz,
    available_until     timestamptz,
    attempt_limit       integer,
    question_count      integer     DEFAULT 0,
    created_at          timestamptz DEFAULT now() NOT NULL,
    updated_at          timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.custom_questions (
    id                  uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
    set_id              uuid        NOT NULL REFERENCES public.custom_question_sets(id) ON DELETE CASCADE,
    user_id             uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    question_text       text        NOT NULL,
    expected_answer     text,
    evaluation_criteria text,
    topic               text,
    skill_category      text,
    difficulty          text        DEFAULT 'intermediate',
    question_type       text        DEFAULT 'open_ended',
    source_page         text,
    display_order       integer     DEFAULT 0,
    time_limit_seconds  integer,
    tags                text[],
    created_at          timestamptz DEFAULT now() NOT NULL,
    updated_at          timestamptz DEFAULT now() NOT NULL
);

-- Interview sessions using custom question sets
CREATE TABLE IF NOT EXISTS public.custom_interview_sessions (
    id                  uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id             uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    question_set_id     uuid        REFERENCES public.custom_question_sets(id) ON DELETE SET NULL,
    interviewer         text        DEFAULT 'amds',
    voice_id            text,
    interview_mode      text        DEFAULT 'exact',     -- exact|with_followups|generated|mixed
    question_count      integer     DEFAULT 5,
    completed_questions integer     DEFAULT 0,
    overall_score       numeric(5,2),
    duration_minutes    integer,
    status              text        DEFAULT 'in_progress',
    started_at          timestamptz DEFAULT now() NOT NULL,
    completed_at        timestamptz,
    created_at          timestamptz DEFAULT now() NOT NULL
);

-- Per-question results for custom sessions (mirrors interview_results)
CREATE TABLE IF NOT EXISTS public.custom_interview_results (
    id                      uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
    session_id              uuid        NOT NULL REFERENCES public.custom_interview_sessions(id) ON DELETE CASCADE,
    user_id                 uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    custom_question_id      uuid        REFERENCES public.custom_questions(id) ON DELETE SET NULL,
    question_number         integer     NOT NULL,
    question_text           text        NOT NULL,
    user_answer             text,
    ideal_answer            text,
    score                   numeric(5,2),
    strengths               text[],
    weaknesses              text[],
    technical_score         numeric(5,2),
    communication_score     numeric(5,2),
    problem_solving_score   numeric(5,2),
    confidence_score        numeric(5,2),
    feedback                text,
    created_at              timestamptz DEFAULT now() NOT NULL
);

-- ---------------------------------------------------------------------------
-- MODULE 2: ATS Resume Analyzer
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ats_analyses (
    id                      uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id                 uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    resume_file_path        text,           -- private Storage path
    resume_file_name        text,
    resume_text             text,           -- extracted text (not raw file)
    job_description         text,
    job_title               text,
    company_name            text,
    experience_level        text,
    ats_readiness_score     integer,        -- 0-100
    jd_match_score          integer,        -- 0-100
    parsing_status          text,           -- ok|partial|failed
    parsing_issues          text[],
    strong_points           text[],
    critical_issues         text[],
    formatting_warnings     text[],
    missing_sections        text[],
    required_keywords_found text[],
    required_keywords_missing text[],
    preferred_keywords_found text[],
    skills_to_highlight     text[],
    recommendations         jsonb,          -- [{priority, category, message, example}]
    improved_resume_text    text,
    improved_file_path      text,
    version_number          integer         DEFAULT 1,
    parent_analysis_id      uuid            REFERENCES public.ats_analyses(id) ON DELETE SET NULL,
    created_at              timestamptz     DEFAULT now() NOT NULL,
    updated_at              timestamptz     DEFAULT now() NOT NULL
);

-- ---------------------------------------------------------------------------
-- MODULE 3: Aptitude Round
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.aptitude_categories (
    id          uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
    name        text    NOT NULL,
    slug        text    NOT NULL UNIQUE,
    description text,
    icon        text,
    sort_order  integer DEFAULT 0,
    is_active   boolean DEFAULT true,
    created_at  timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.aptitude_topics (
    id              uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
    category_id     uuid    NOT NULL REFERENCES public.aptitude_categories(id) ON DELETE CASCADE,
    name            text    NOT NULL,
    slug            text    NOT NULL,
    description     text,
    sort_order      integer DEFAULT 0,
    is_active       boolean DEFAULT true,
    created_at      timestamptz DEFAULT now() NOT NULL,
    UNIQUE(category_id, slug)
);

CREATE TABLE IF NOT EXISTS public.aptitude_questions (
    id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
    topic_id        uuid        NOT NULL REFERENCES public.aptitude_topics(id) ON DELETE CASCADE,
    category_id     uuid        NOT NULL REFERENCES public.aptitude_categories(id) ON DELETE CASCADE,
    question_text   text        NOT NULL,
    question_type   text        NOT NULL DEFAULT 'mcq',  -- mcq|multi_select|numeric|passage_mcq
    options         jsonb,          -- [{id, text}]
    correct_answer  jsonb       NOT NULL,   -- "A" for mcq, ["A","C"] for multi, "42" for numeric
    explanation     text,
    difficulty      text        NOT NULL DEFAULT 'medium',  -- easy|medium|hard
    marks           integer     NOT NULL DEFAULT 1,
    negative_marks  numeric(3,2) DEFAULT 0,
    time_limit_seconds integer,
    passage_text    text,           -- for passage-based questions
    image_url       text,
    tags            text[],
    is_published    boolean     NOT NULL DEFAULT false,
    is_validated    boolean     NOT NULL DEFAULT false,
    created_by      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,
    updated_at      timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.aptitude_assessments (
    id                  uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
    name                text        NOT NULL,
    description         text,
    assessment_type     text        NOT NULL DEFAULT 'topic_practice',
    -- topic_practice|timed_test|full_mock|daily_challenge|weak_area
    category_ids        uuid[],
    topic_ids           uuid[],
    difficulty          text,       -- null = mixed
    question_count      integer     NOT NULL DEFAULT 10,
    time_limit_minutes  integer,
    negative_marking    boolean     DEFAULT false,
    allow_review        boolean     DEFAULT true,
    show_answers_during boolean     DEFAULT false,
    is_active           boolean     DEFAULT true,
    created_by          uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at          timestamptz DEFAULT now() NOT NULL,
    updated_at          timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.aptitude_attempts (
    id                  uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id             uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    assessment_id       uuid        REFERENCES public.aptitude_assessments(id) ON DELETE SET NULL,
    attempt_type        text        NOT NULL DEFAULT 'practice',
    -- practice|timed_test|full_mock|daily_challenge|weak_area|topic_wise
    category_id         uuid        REFERENCES public.aptitude_categories(id) ON DELETE SET NULL,
    topic_id            uuid        REFERENCES public.aptitude_topics(id) ON DELETE SET NULL,
    question_ids        uuid[]      NOT NULL DEFAULT '{}',
    total_questions     integer     NOT NULL DEFAULT 0,
    answered_count      integer     NOT NULL DEFAULT 0,
    correct_count       integer     NOT NULL DEFAULT 0,
    wrong_count         integer     NOT NULL DEFAULT 0,
    skipped_count       integer     NOT NULL DEFAULT 0,
    score               integer     NOT NULL DEFAULT 0,
    max_score           integer     NOT NULL DEFAULT 0,
    accuracy            numeric(5,2),
    time_taken_seconds  integer,
    time_limit_seconds  integer,
    status              text        NOT NULL DEFAULT 'in_progress',
    -- in_progress|completed|abandoned|time_expired
    started_at          timestamptz DEFAULT now() NOT NULL,
    completed_at        timestamptz,
    created_at          timestamptz DEFAULT now() NOT NULL,
    updated_at          timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.aptitude_responses (
    id                  uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
    attempt_id          uuid        NOT NULL REFERENCES public.aptitude_attempts(id) ON DELETE CASCADE,
    user_id             uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    question_id         uuid        NOT NULL REFERENCES public.aptitude_questions(id) ON DELETE CASCADE,
    user_answer         jsonb,      -- null = skipped
    is_correct          boolean,
    is_bookmarked       boolean     DEFAULT false,
    marks_earned        numeric(4,2) DEFAULT 0,
    time_taken_seconds  integer,
    answered_at         timestamptz,
    created_at          timestamptz DEFAULT now() NOT NULL
);

-- User topic-level performance summary (updated after each attempt)
CREATE TABLE IF NOT EXISTS public.aptitude_topic_performance (
    id                  uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id             uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    topic_id            uuid        NOT NULL REFERENCES public.aptitude_topics(id) ON DELETE CASCADE,
    total_attempts      integer     DEFAULT 0,
    total_questions     integer     DEFAULT 0,
    correct_count       integer     DEFAULT 0,
    accuracy            numeric(5,2),
    avg_time_seconds    numeric(7,2),
    last_attempted_at   timestamptz,
    updated_at          timestamptz DEFAULT now() NOT NULL,
    UNIQUE(user_id, topic_id)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_custom_question_sets_user    ON public.custom_question_sets (user_id);
CREATE INDEX IF NOT EXISTS idx_custom_question_sets_admin   ON public.custom_question_sets (is_admin_set, is_published) WHERE is_admin_set = true;
CREATE INDEX IF NOT EXISTS idx_custom_questions_set         ON public.custom_questions (set_id, display_order);
CREATE INDEX IF NOT EXISTS idx_custom_interview_sessions_user ON public.custom_interview_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_custom_interview_results_session ON public.custom_interview_results (session_id);
CREATE INDEX IF NOT EXISTS idx_ats_analyses_user            ON public.ats_analyses (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aptitude_questions_topic     ON public.aptitude_questions (topic_id) WHERE is_published = true;
CREATE INDEX IF NOT EXISTS idx_aptitude_questions_category  ON public.aptitude_questions (category_id) WHERE is_published = true;
CREATE INDEX IF NOT EXISTS idx_aptitude_attempts_user       ON public.aptitude_attempts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aptitude_responses_attempt   ON public.aptitude_responses (attempt_id);
CREATE INDEX IF NOT EXISTS idx_aptitude_perf_user_topic     ON public.aptitude_topic_performance (user_id, accuracy);

-- ---------------------------------------------------------------------------
-- Updated_at triggers
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_custom_question_sets_updated_at ON public.custom_question_sets;
CREATE TRIGGER trg_custom_question_sets_updated_at
    BEFORE UPDATE ON public.custom_question_sets
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_custom_questions_updated_at ON public.custom_questions;
CREATE TRIGGER trg_custom_questions_updated_at
    BEFORE UPDATE ON public.custom_questions
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_ats_analyses_updated_at ON public.ats_analyses;
CREATE TRIGGER trg_ats_analyses_updated_at
    BEFORE UPDATE ON public.ats_analyses
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_aptitude_attempts_updated_at ON public.aptitude_attempts;
CREATE TRIGGER trg_aptitude_attempts_updated_at
    BEFORE UPDATE ON public.aptitude_attempts
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_aptitude_perf_updated_at ON public.aptitude_topic_performance;
CREATE TRIGGER trg_aptitude_perf_updated_at
    BEFORE UPDATE ON public.aptitude_topic_performance
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE public.custom_question_sets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_questions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_interview_sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_interview_results    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ats_analyses                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aptitude_categories         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aptitude_topics             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aptitude_questions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aptitude_assessments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aptitude_attempts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aptitude_responses          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aptitude_topic_performance  ENABLE ROW LEVEL SECURITY;

-- custom_question_sets: users see own + published admin sets
DROP POLICY IF EXISTS "cqs_select"  ON public.custom_question_sets;
DROP POLICY IF EXISTS "cqs_insert"  ON public.custom_question_sets;
DROP POLICY IF EXISTS "cqs_update"  ON public.custom_question_sets;
DROP POLICY IF EXISTS "cqs_delete"  ON public.custom_question_sets;

CREATE POLICY "cqs_select" ON public.custom_question_sets FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR (is_admin_set = true AND is_published = true) OR app_private.current_user_is_admin());
CREATE POLICY "cqs_insert" ON public.custom_question_sets FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid() AND is_admin_set = false);
CREATE POLICY "cqs_insert_admin" ON public.custom_question_sets FOR INSERT TO authenticated
    WITH CHECK (app_private.current_user_is_admin());
CREATE POLICY "cqs_update" ON public.custom_question_sets FOR UPDATE TO authenticated
    USING (user_id = auth.uid() OR app_private.current_user_is_admin());
CREATE POLICY "cqs_delete" ON public.custom_question_sets FOR DELETE TO authenticated
    USING (user_id = auth.uid() OR app_private.current_user_is_admin());

-- custom_questions: owner or admin
DROP POLICY IF EXISTS "cq_select" ON public.custom_questions;
DROP POLICY IF EXISTS "cq_all"    ON public.custom_questions;
CREATE POLICY "cq_select" ON public.custom_questions FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR app_private.current_user_is_admin() OR
           EXISTS (SELECT 1 FROM public.custom_question_sets s WHERE s.id = set_id AND s.is_admin_set = true AND s.is_published = true));
CREATE POLICY "cq_insert" ON public.custom_questions FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid() OR app_private.current_user_is_admin());
CREATE POLICY "cq_update" ON public.custom_questions FOR UPDATE TO authenticated
    USING (user_id = auth.uid() OR app_private.current_user_is_admin());
CREATE POLICY "cq_delete" ON public.custom_questions FOR DELETE TO authenticated
    USING (user_id = auth.uid() OR app_private.current_user_is_admin());

-- custom_interview_sessions: own only
DROP POLICY IF EXISTS "cis_own" ON public.custom_interview_sessions;
CREATE POLICY "cis_own" ON public.custom_interview_sessions FOR ALL TO authenticated
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- custom_interview_results: own only
DROP POLICY IF EXISTS "cir_own" ON public.custom_interview_results;
CREATE POLICY "cir_own" ON public.custom_interview_results FOR ALL TO authenticated
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ats_analyses: own only
DROP POLICY IF EXISTS "ats_own" ON public.ats_analyses;
CREATE POLICY "ats_own" ON public.ats_analyses FOR ALL TO authenticated
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- aptitude_categories: public read, admin write
DROP POLICY IF EXISTS "apt_cat_read"  ON public.aptitude_categories;
DROP POLICY IF EXISTS "apt_cat_write" ON public.aptitude_categories;
CREATE POLICY "apt_cat_read"  ON public.aptitude_categories FOR SELECT TO authenticated USING (true);
CREATE POLICY "apt_cat_write" ON public.aptitude_categories FOR ALL TO authenticated
    USING (app_private.current_user_is_admin()) WITH CHECK (app_private.current_user_is_admin());

-- aptitude_topics: public read, admin write
DROP POLICY IF EXISTS "apt_top_read"  ON public.aptitude_topics;
DROP POLICY IF EXISTS "apt_top_write" ON public.aptitude_topics;
CREATE POLICY "apt_top_read"  ON public.aptitude_topics FOR SELECT TO authenticated USING (true);
CREATE POLICY "apt_top_write" ON public.aptitude_topics FOR ALL TO authenticated
    USING (app_private.current_user_is_admin()) WITH CHECK (app_private.current_user_is_admin());

-- aptitude_questions: published = public read, admin = full write
DROP POLICY IF EXISTS "apt_q_read"  ON public.aptitude_questions;
DROP POLICY IF EXISTS "apt_q_write" ON public.aptitude_questions;
CREATE POLICY "apt_q_read"  ON public.aptitude_questions FOR SELECT TO authenticated
    USING (is_published = true OR app_private.current_user_is_admin());
CREATE POLICY "apt_q_write" ON public.aptitude_questions FOR ALL TO authenticated
    USING (app_private.current_user_is_admin()) WITH CHECK (app_private.current_user_is_admin());

-- aptitude_assessments: active = public read, admin = full
DROP POLICY IF EXISTS "apt_assess_read"  ON public.aptitude_assessments;
DROP POLICY IF EXISTS "apt_assess_write" ON public.aptitude_assessments;
CREATE POLICY "apt_assess_read"  ON public.aptitude_assessments FOR SELECT TO authenticated USING (is_active = true OR app_private.current_user_is_admin());
CREATE POLICY "apt_assess_write" ON public.aptitude_assessments FOR ALL TO authenticated
    USING (app_private.current_user_is_admin()) WITH CHECK (app_private.current_user_is_admin());

-- aptitude_attempts: own only
DROP POLICY IF EXISTS "apt_att_own" ON public.aptitude_attempts;
CREATE POLICY "apt_att_own" ON public.aptitude_attempts FOR ALL TO authenticated
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- aptitude_responses: own only
DROP POLICY IF EXISTS "apt_resp_own" ON public.aptitude_responses;
CREATE POLICY "apt_resp_own" ON public.aptitude_responses FOR ALL TO authenticated
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- aptitude_topic_performance: own only
DROP POLICY IF EXISTS "apt_perf_own" ON public.aptitude_topic_performance;
CREATE POLICY "apt_perf_own" ON public.aptitude_topic_performance FOR ALL TO authenticated
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Seed: Aptitude categories and topics
-- ---------------------------------------------------------------------------
INSERT INTO public.aptitude_categories (name, slug, description, icon, sort_order) VALUES
  ('Quantitative Aptitude', 'quantitative', 'Numbers, percentages, algebra, probability', '🔢', 1),
  ('Logical Reasoning',     'logical',      'Series, puzzles, syllogisms, patterns',     '🧠', 2),
  ('Verbal Ability',        'verbal',       'Grammar, vocabulary, comprehension',         '📖', 3),
  ('Data Interpretation',   'data-interp',  'Tables, charts, graphs, data sets',          '📊', 4)
ON CONFLICT (slug) DO NOTHING;

-- Quantitative topics
INSERT INTO public.aptitude_topics (category_id, name, slug, sort_order)
SELECT c.id, t.name, t.slug, t.ord FROM public.aptitude_categories c,
  (VALUES
    ('Percentages',                   'percentages',        1),
    ('Ratios & Proportions',          'ratios',             2),
    ('Averages',                      'averages',           3),
    ('Profit & Loss',                 'profit-loss',        4),
    ('Simple & Compound Interest',    'interest',           5),
    ('Time & Work',                   'time-work',          6),
    ('Speed, Time & Distance',        'speed-distance',     7),
    ('Number Systems',                'number-systems',     8),
    ('Probability',                   'probability',        9),
    ('Permutations & Combinations',   'perm-comb',         10),
    ('Basic Algebra',                 'algebra',           11)
  ) AS t(name, slug, ord)
WHERE c.slug = 'quantitative'
ON CONFLICT (category_id, slug) DO NOTHING;

-- Logical topics
INSERT INTO public.aptitude_topics (category_id, name, slug, sort_order)
SELECT c.id, t.name, t.slug, t.ord FROM public.aptitude_categories c,
  (VALUES
    ('Number & Letter Series',  'series',           1),
    ('Coding & Decoding',       'coding-decoding',  2),
    ('Analogies',               'analogies',        3),
    ('Syllogisms',              'syllogisms',       4),
    ('Blood Relations',         'blood-relations',  5),
    ('Directions',              'directions',       6),
    ('Seating Arrangements',    'seating',          7),
    ('Puzzles',                 'puzzles',          8),
    ('Logical Deductions',      'deductions',       9),
    ('Pattern Recognition',     'patterns',        10)
  ) AS t(name, slug, ord)
WHERE c.slug = 'logical'
ON CONFLICT (category_id, slug) DO NOTHING;

-- Verbal topics
INSERT INTO public.aptitude_topics (category_id, name, slug, sort_order)
SELECT c.id, t.name, t.slug, t.ord FROM public.aptitude_categories c,
  (VALUES
    ('Grammar',              'grammar',            1),
    ('Vocabulary',           'vocabulary',         2),
    ('Sentence Correction',  'sentence-correction',3),
    ('Reading Comprehension','reading-comp',       4),
    ('Sentence Completion',  'sentence-completion',5),
    ('Para Jumbles',         'para-jumbles',       6),
    ('Error Identification', 'error-id',           7)
  ) AS t(name, slug, ord)
WHERE c.slug = 'verbal'
ON CONFLICT (category_id, slug) DO NOTHING;

-- Data Interpretation topics
INSERT INTO public.aptitude_topics (category_id, name, slug, sort_order)
SELECT c.id, t.name, t.slug, t.ord FROM public.aptitude_categories c,
  (VALUES
    ('Bar Charts',      'bar-charts',  1),
    ('Line Graphs',     'line-graphs', 2),
    ('Pie Charts',      'pie-charts',  3),
    ('Tables',          'tables',      4),
    ('Mixed Graphs',    'mixed',       5)
  ) AS t(name, slug, ord)
WHERE c.slug = 'data-interp'
ON CONFLICT (category_id, slug) DO NOTHING;
