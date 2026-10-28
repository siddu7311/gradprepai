import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Helmet } from 'react-helmet-async';
import {
  Brain, BarChart3, BookOpen, Target, TrendingUp, ChevronRight, Play,
  Timer, CheckCircle, XCircle, SkipForward, Flag, Award, Loader2,
  ArrowLeft, ArrowRight, AlertCircle, Zap, RefreshCw, Home
} from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { GlassCard } from '@/components/ui/GlassCard';
import { GlowButton } from '@/components/ui/GlowButton';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useAptitude, type AptitudeQuestion } from '@/hooks/useAptitude';
import {
  describeAptitudeCategoryError,
  calculatePracticeResults,
  getPracticeCategoryIds,
  includeDraftAnswers,
  isPracticeAnswerCorrect,
  type PracticeResponse,
  validatePracticeQuestions,
} from '@/lib/aptitudePractice';
import { Link } from 'react-router-dom';

type SessionPhase = 'home' | 'session' | 'results';
type PracticeMode = 'practice' | 'timed';

interface AttemptResult {
  correct: number;
  wrong: number;
  skipped: number;
  score: number;
  maxScore: number;
  accuracy: number;
  timeTaken: number;
  questions: AptitudeQuestion[];
  responses: Record<string, { answer: string | string[] | null; isCorrect: boolean | null }>;
}

function TimerBadge({ seconds, limit }: { seconds: number; limit: number }) {
  const remaining = Math.max(0, limit - seconds);
  const pct = (remaining / limit) * 100;
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const color = pct > 50 ? 'text-green-400' : pct > 20 ? 'text-yellow-400' : 'text-red-400';
  return (
    <div className={`flex items-center gap-1 font-mono font-semibold ${color}`}>
      <Timer className="w-4 h-4" />
      {mins}:{secs.toString().padStart(2, '0')}
    </div>
  );
}

export default function AptitudeRound() {
  const { user } = useAuth();
  const { startAttempt, submitResponse, completeAttempt, loadQuestionsForTopic, loadQuestionsForCategories, loading: aptLoading } = useAptitude();

  const [phase, setPhase] = useState<SessionPhase>('home');
  const [mode, setMode] = useState<PracticeMode>('practice');
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [selectedTopic, setSelectedTopic] = useState<string>('');
  const [selectedDifficulty, setSelectedDifficulty] = useState<string>('');
  const [questionCount, setQuestionCount] = useState(10);
  const [timeLimitMinutes, setTimeLimitMinutes] = useState(15);
  const [questions, setQuestions] = useState<AptitudeQuestion[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [responses, setResponses] = useState<Record<string, PracticeResponse>>({});
  const [isMixedPractice, setIsMixedPractice] = useState(false);
  const [showExplanation, setShowExplanation] = useState(false);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [sessionResult, setSessionResult] = useState<AttemptResult | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState('dashboard');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const responsesRef = useRef<Record<string, PracticeResponse>>({});
  const draftAnswersRef = useRef<Record<string, string | null>>({});
  const startTimeRef = useRef<number>(Date.now());
  const timeLimitRef = useRef<number>(timeLimitMinutes);
  const startLockRef = useRef(false);
  const finishLockRef = useRef(false);

  // Data queries
  const {
    data: categories = [],
    isLoading: categoriesLoading,
    error: categoriesError,
    refetch: refetchCategories,
  } = useQuery({
    queryKey: ['aptitude_categories'],
    queryFn: async () => {
      const { data, error } = await supabase.from('aptitude_categories').select('*').eq('is_active', true).order('sort_order');
      if (error) {
        console.error('Failed to fetch aptitude categories from Supabase:', error);
        throw error;
      }
      return data || [];
    },
    retry: false,
  });

  const { data: topics = [] } = useQuery({
    queryKey: ['aptitude_topics', selectedCategory],
    queryFn: async () => {
      if (!selectedCategory) return [];
      const { data, error } = await supabase.from('aptitude_topics').select('*').eq('category_id', selectedCategory).eq('is_active', true).order('sort_order');
      if (error) throw error;
      return data || [];
    },
    enabled: !!selectedCategory,
  });

  const { data: attempts = [] } = useQuery({
    queryKey: ['aptitude_attempts', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data, error } = await supabase
        .from('aptitude_attempts')
        .select('*')
        .eq('user_id', user.id)
        .eq('status', 'completed')
        .order('completed_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data || [];
    },
    enabled: !!user?.id,
  });

  const { data: topicPerformance = [] } = useQuery({
    queryKey: ['aptitude_topic_performance', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data, error } = await supabase
        .from('aptitude_topic_performance')
        .select('*, aptitude_topics(name, aptitude_categories(name))')
        .eq('user_id', user.id)
        .order('accuracy', { ascending: true })
        .limit(10);
      if (error) throw error;
      return data || [];
    },
    enabled: !!user?.id,
  });

  // Keep timeLimitRef in sync so the interval closure always reads the latest value
  useEffect(() => { timeLimitRef.current = timeLimitMinutes; }, [timeLimitMinutes]);

  // Stable ref so the interval callback always calls the latest handleFinishSession
  // without needing handleFinishSession as an interval dependency.
  const handleFinishRef = useRef<(timeExpired?: boolean) => Promise<void>>(async () => {});

  const handleStartSession = async () => {
    if (startLockRef.current || isSubmitting || aptLoading) return;
    const categoryIds = getPracticeCategoryIds(categories, selectedCategory, isMixedPractice);
    if (categoryIds.length === 0) {
      toast.error('Please select an aptitude category or Mixed Practice before starting.');
      return;
    }
    startLockRef.current = true;
    setIsSubmitting(true);
    try {
      // Resolve human-readable names so the AI fallback has enough context
      const catObj = categories.find((c: { id: string; name: string }) => c.id === selectedCategory);
      const topObj = topics.find((t: { id: string; name: string }) => t.id === selectedTopic);

      let qs: AptitudeQuestion[];
      if (!isMixedPractice && selectedTopic && topObj) {
        qs = await loadQuestionsForTopic({
          topic_id: selectedTopic,
          category_id: selectedCategory,
          topic_name: topObj.name,
          category_name: catObj?.name,
          difficulty: selectedDifficulty || undefined,
          count: questionCount,
        });
      } else {
        qs = await loadQuestionsForCategories({
          category_ids: categoryIds,
          category_name: isMixedPractice ? 'Mixed Practice' : catObj?.name,
          topic_name: isMixedPractice ? 'Mixed Practice' : catObj?.name,
          difficulty: selectedDifficulty || undefined,
          count: questionCount,
        });
      }

      const questionError = validatePracticeQuestions(qs);
      if (questionError) {
        toast.error(questionError);
        return;
      }

      const id = await startAttempt({
        attempt_type: mode === 'timed' ? 'timed_test' : 'practice',
        category_id: isMixedPractice ? undefined : selectedCategory,
        topic_id: selectedTopic || undefined,
        questions: qs,
        time_limit_seconds: mode === 'timed' ? timeLimitMinutes * 60 : undefined,
      });

      setAttemptId(id);
      setQuestions(qs);
      setCurrentIdx(0);
      setSelectedAnswer(null);
      setResponses({});
      responsesRef.current = {};
      draftAnswersRef.current = {};
      setShowExplanation(false);
      setElapsedSeconds(0);
      startTimeRef.current = Date.now();
      setPhase('session');
    } catch (err) {
      console.error('Unable to start aptitude practice:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to start session');
    } finally {
      startLockRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleAnswerSelect = (answer: string) => {
    const question = questions[currentIdx];
    if (!question || responsesRef.current[question.id]) return;
    draftAnswersRef.current = { ...draftAnswersRef.current, [question.id]: answer };
    setSelectedAnswer(answer);
  };

  const handleSubmitAnswer = async () => {
    const q = questions[currentIdx];
    if (!q || !attemptId || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const result = await submitResponse({ attempt_id: attemptId, question: q, user_answer: selectedAnswer, time_taken_seconds: elapsedSeconds });
      const newResponses = {
        ...responsesRef.current,
        [q.id]: { answer: selectedAnswer, isCorrect: result?.isCorrect ?? null },
      };
      responsesRef.current = newResponses;
      const remainingDrafts = { ...draftAnswersRef.current };
      delete remainingDrafts[q.id];
      draftAnswersRef.current = remainingDrafts;
      setResponses(newResponses);
      if (mode === 'practice') setShowExplanation(true);
    } catch (err) {
      console.error('Unable to save aptitude answer:', err);
      toast.error(err instanceof Error ? err.message : 'Unable to save your answer. Please retry.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleNext = () => {
    setShowExplanation(false);
    if (currentIdx + 1 < questions.length) {
      const nextIdx = currentIdx + 1;
      setSelectedAnswer(draftAnswersRef.current[questions[nextIdx].id] ?? null);
      setCurrentIdx(nextIdx);
    } else {
      handleFinishSession();
    }
  };

  const handleSkip = async () => {
    const q = questions[currentIdx];
    if (!q || !attemptId || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await submitResponse({ attempt_id: attemptId, question: q, user_answer: null });
      const newResponses = {
        ...responsesRef.current,
        [q.id]: { answer: null, isCorrect: null },
      };
      const remainingDrafts = { ...draftAnswersRef.current };
      delete remainingDrafts[q.id];
      draftAnswersRef.current = remainingDrafts;
      responsesRef.current = newResponses;
      setResponses(newResponses);
      handleNext();
    } catch (err) {
      console.error('Unable to save skipped aptitude question:', err);
      toast.error(err instanceof Error ? err.message : 'Unable to save your skipped question.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFinishSession = useCallback(async (
    timeExpired = false,
    finalResponses: Record<string, PracticeResponse> = responsesRef.current,
  ) => {
    if (!attemptId || finishLockRef.current) return;
    finishLockRef.current = true;
    if (timerRef.current) clearInterval(timerRef.current);
    setIsSubmitting(true);
    try {
      const drafts = { ...draftAnswersRef.current };
      const activeQuestion = questions[currentIdx];
      if (activeQuestion && selectedAnswer) drafts[activeQuestion.id] = selectedAnswer;
      const scoredResponses = includeDraftAnswers(questions, finalResponses, drafts);
      responsesRef.current = scoredResponses;
      setResponses(scoredResponses);
      const localResult = calculatePracticeResults(questions, scoredResponses);
      setSessionResult({
        correct: localResult.correct,
        wrong: localResult.wrong,
        skipped: localResult.skipped,
        score: localResult.score,
        maxScore: questions.reduce((total, question) => total + question.marks, 0),
        accuracy: localResult.accuracy,
        timeTaken: Math.floor((Date.now() - startTimeRef.current) / 1000),
        questions,
        responses: scoredResponses,
      });
      setPhase('results');

      try {
        await completeAttempt(attemptId, questions, scoredResponses);
      } catch (err) {
        console.error('Unable to persist aptitude attempt results:', err);
        toast.error('Your results are shown, but this attempt could not be saved to history.');
      }
      if (timeExpired) toast.info("Time's up! Your answers have been submitted.");
    } catch (err) {
      console.error('Unable to complete aptitude practice:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to submit session');
    } finally {
      finishLockRef.current = false;
      setIsSubmitting(false);
    }
  }, [attemptId, completeAttempt, currentIdx, questions, selectedAnswer]);

  // Sync the stable ref after handleFinishSession is defined
  useEffect(() => { handleFinishRef.current = handleFinishSession; }, [handleFinishSession]);

  // Timer for timed mode — reads handleFinishRef so it never stales
  useEffect(() => {
    if (phase === 'session' && mode === 'timed') {
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setElapsedSeconds(elapsed);
        if (elapsed >= timeLimitRef.current * 60) {
          handleFinishRef.current(true);
        }
      }, 1000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phase, mode]); // intentionally only re-runs on phase/mode change

  const currentQ = questions[currentIdx];
  const hasAnswered = currentQ && responses[currentQ.id] !== undefined;
  const answeredCount = Object.values(responses).filter(r => r.answer !== null).length;
  const visibleResult = sessionResult ?? (phase === 'results' && questions.length > 0
    ? (() => {
        const finalResponses = includeDraftAnswers(questions, responsesRef.current, draftAnswersRef.current);
        const result = calculatePracticeResults(questions, finalResponses);
        return {
          ...result,
          maxScore: questions.reduce((total, question) => total + question.marks, 0),
          timeTaken: Math.floor((Date.now() - startTimeRef.current) / 1000),
          questions,
          responses: finalResponses,
        };
      })()
    : null);

  if (!user) {
    return (
      <MainLayout>
        <div className="container mx-auto px-4 py-12 text-center">
          <p className="text-muted-foreground">Please sign in to access Aptitude Round.</p>
        </div>
      </MainLayout>
    );
  }

  return (
    <>
      <Helmet>
        <title>Aptitude Round - GradPrep AI</title>
      </Helmet>
      <MainLayout>
        <div className="container mx-auto px-4 py-8 max-w-5xl">

          {/* ── HOME / DASHBOARD ── */}
          {phase === 'home' && (
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
              <div className="mb-8">
                <h1 className="font-display text-3xl font-bold text-foreground mb-2 flex items-center gap-3">
                  <Brain className="w-8 h-8 text-primary" />
                  Aptitude Round
                </h1>
                <p className="text-muted-foreground">Practice quantitative, logical, and verbal aptitude for campus placements and competitive exams.</p>
              </div>

              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="mb-6">
                  <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
                  <TabsTrigger value="practice">Practice</TabsTrigger>
                  <TabsTrigger value="history">History</TabsTrigger>
                </TabsList>

                <TabsContent value="dashboard">
                  {/* Stats row */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                    {[
                      { label: 'Tests Taken', value: attempts.length, icon: BarChart3, color: 'from-primary to-accent' },
                      { label: 'Questions Answered', value: attempts.reduce((s: number, a: { answered_count?: number }) => s + (a.answered_count || 0), 0), icon: CheckCircle, color: 'from-green-500 to-emerald-500' },
                      { label: 'Avg. Accuracy', value: attempts.length > 0 ? `${Math.round(attempts.reduce((s: number, a: { accuracy?: number }) => s + (a.accuracy || 0), 0) / attempts.length)}%` : '--', icon: Target, color: 'from-yellow-500 to-orange-500' },
                      { label: 'Best Score', value: attempts.length > 0 ? Math.max(...attempts.map((a: { score?: number }) => a.score || 0)) : '--', icon: Award, color: 'from-secondary to-purple-600' },
                    ].map(stat => (
                      <GlassCard key={stat.label} className="p-4">
                        <div className={`w-8 h-8 rounded-lg bg-gradient-to-br ${stat.color} p-1.5 mb-2`}>
                          <stat.icon className="w-full h-full text-white" />
                        </div>
                        <p className="text-2xl font-bold text-foreground">{stat.value}</p>
                        <p className="text-xs text-muted-foreground">{stat.label}</p>
                      </GlassCard>
                    ))}
                  </div>

                  {/* Category cards */}
                  <h2 className="text-lg font-semibold text-foreground mb-3">Practice by Category</h2>
                  {categoriesLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground mb-6" role="status">
                      <Loader2 className="w-4 h-4 animate-spin" /> Loading categories…
                    </div>
                  ) : categoriesError ? (
                    <div className="flex items-center gap-3 text-sm text-destructive mb-6" role="alert">
                      <span>{describeAptitudeCategoryError(categoriesError)}</span>
                      <Button type="button" variant="outline" size="sm" onClick={() => refetchCategories()}>Retry</Button>
                    </div>
                  ) : categories.length === 0 ? (
                    <p className="text-sm text-muted-foreground mb-6" role="status">No aptitude categories are currently available.</p>
                  ) : (
                    <div className="grid md:grid-cols-2 gap-4 mb-6">
                      {categories.map((cat: { id: string; name: string; description: string | null; icon: string | null }) => (
                        <GlassCard
                          key={cat.id}
                          className="p-4 cursor-pointer group hover:border-primary/40 transition-all"
                          onClick={() => {
                            setSelectedCategory(cat.id);
                            setIsMixedPractice(false);
                            setSelectedTopic('');
                            setActiveTab('practice');
                          }}
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-xl">{cat.icon || '📘'}</span>
                                <h3 className="font-semibold text-foreground">{cat.name}</h3>
                              </div>
                              <p className="text-sm text-muted-foreground">{cat.description}</p>
                            </div>
                            <ChevronRight className="w-5 h-5 text-muted-foreground group-hover:text-primary group-hover:translate-x-1 transition-all" />
                          </div>
                        </GlassCard>
                      ))}
                    </div>
                  )}

                  {/* Weak areas */}
                  {topicPerformance.length > 0 && (
                    <div>
                      <h2 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
                        <TrendingUp className="w-5 h-5 text-yellow-500" /> Areas to Improve
                      </h2>
                      <div className="space-y-2">
                        {topicPerformance.slice(0, 5).map((tp: { topic_id: string; accuracy: number | null; aptitude_topics?: { name: string } }) => (
                          <div key={tp.topic_id} className="glass border border-glass-border/30 rounded-xl p-3 flex items-center justify-between">
                            <span className="text-sm text-foreground">{tp.aptitude_topics?.name || 'Topic'}</span>
                            <div className="flex items-center gap-3">
                              <Progress value={tp.accuracy ?? 0} className="w-20 h-2" />
                              <span className="text-sm font-medium text-yellow-400">{tp.accuracy ?? 0}%</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="practice">
                  {/* Quick start */}
                  <GlassCard className="p-6 space-y-4">
                    <h2 className="font-semibold text-foreground">Quick Practice</h2>
                    {categoriesLoading ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                        <Loader2 className="w-4 h-4 animate-spin" /> Loading aptitude categories…
                      </div>
                    ) : categoriesError ? (
                      <div className="flex flex-wrap items-center gap-3 text-sm text-destructive" role="alert">
                        <span>{describeAptitudeCategoryError(categoriesError)}</span>
                        <Button type="button" variant="outline" size="sm" onClick={() => refetchCategories()}>
                          <RefreshCw className="w-4 h-4 mr-2" /> Retry
                        </Button>
                      </div>
                    ) : categories.length === 0 ? (
                      <p className="text-sm text-muted-foreground" role="status">
                        No aptitude categories are currently available.
                      </p>
                    ) : (
                    <>
                    <div className="grid sm:grid-cols-2 gap-3" aria-label="Select a practice category">
                      {categories.map((category: { id: string; name: string; description?: string | null; icon?: string | null }) => {
                        const isSelected = !isMixedPractice && selectedCategory === category.id;
                        return (
                          <button
                            key={category.id}
                            type="button"
                            aria-pressed={isSelected}
                            onClick={() => {
                              setSelectedCategory(isSelected ? '' : category.id);
                              setIsMixedPractice(false);
                              setSelectedTopic('');
                            }}
                            className={`text-left rounded-xl border p-4 transition-all ${
                              isSelected
                                ? 'border-primary bg-primary/10 ring-1 ring-primary/40'
                                : 'border-glass-border/30 glass hover:border-primary/40'
                            }`}
                          >
                            <span className="flex items-center gap-2 font-medium text-foreground">
                              <span>{category.icon || '📘'}</span>{category.name}
                              {isSelected && <CheckCircle className="ml-auto h-4 w-4 text-primary" />}
                            </span>
                            {category.description && <span className="mt-1 block text-xs text-muted-foreground">{category.description}</span>}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        aria-pressed={isMixedPractice}
                        onClick={() => {
                          setIsMixedPractice(!isMixedPractice);
                          setSelectedCategory('');
                          setSelectedTopic('');
                        }}
                        className={`text-left rounded-xl border p-4 transition-all ${
                          isMixedPractice
                            ? 'border-primary bg-primary/10 ring-1 ring-primary/40'
                            : 'border-glass-border/30 glass hover:border-primary/40'
                        }`}
                      >
                        <span className="flex items-center gap-2 font-medium text-foreground">
                          <span>🎯</span>Mixed Practice
                          {isMixedPractice && <CheckCircle className="ml-auto h-4 w-4 text-primary" />}
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">Questions from all available categories.</span>
                      </button>
                    </div>
                    <div className="grid md:grid-cols-2 gap-4">
                      <div>
                        <label className="text-sm text-muted-foreground block mb-1">Topic (optional)</label>
                        <Select
                          value={selectedTopic || 'all-topics'}
                          onValueChange={(value) => setSelectedTopic(value === 'all-topics' ? '' : value)}
                          disabled={!selectedCategory || isMixedPractice}
                        >
                          <SelectTrigger><SelectValue placeholder="All topics" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all-topics">All topics</SelectItem>
                            {topics.map((t: { id: string; name: string }) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <label className="text-sm text-muted-foreground block mb-1">Difficulty</label>
                        <Select
                          value={selectedDifficulty || 'any-difficulty'}
                          onValueChange={(value) => setSelectedDifficulty(value === 'any-difficulty' ? '' : value)}
                        >
                          <SelectTrigger><SelectValue placeholder="Any difficulty" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="any-difficulty">Any</SelectItem>
                            <SelectItem value="easy">Easy</SelectItem>
                            <SelectItem value="medium">Medium</SelectItem>
                            <SelectItem value="hard">Hard</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <label className="text-sm text-muted-foreground block mb-1">Questions</label>
                        <Select value={String(questionCount)} onValueChange={(v) => setQuestionCount(Number(v))}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {[5, 10, 15, 20, 25].map(n => <SelectItem key={n} value={String(n)}>{n} questions</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <label className="text-sm text-muted-foreground block mb-1">Mode</label>
                        <Select value={mode} onValueChange={(v) => setMode(v as PracticeMode)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="practice">Practice (with explanations)</SelectItem>
                            <SelectItem value="timed">Timed Test</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {mode === 'timed' && (
                        <div>
                          <label className="text-sm text-muted-foreground block mb-1">Time Limit</label>
                          <Select value={String(timeLimitMinutes)} onValueChange={(v) => setTimeLimitMinutes(Number(v))}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {[10, 15, 20, 30, 45, 60].map(m => <SelectItem key={m} value={String(m)}>{m} minutes</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>
                    </>
                    )}
                    <GlowButton
                      onClick={handleStartSession}
                      disabled={isSubmitting || aptLoading || categoriesLoading || !!categoriesError || categories.length === 0}
                      className="w-full md:w-auto"
                    >
                      {(isSubmitting || aptLoading) ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                      Start {mode === 'timed' ? 'Timed Test' : 'Practice'}
                    </GlowButton>
                  </GlassCard>
                </TabsContent>

                <TabsContent value="history">
                  {attempts.length === 0 ? (
                    <GlassCard className="p-8 text-center">
                      <BarChart3 className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                      <p className="text-foreground font-medium">No attempts yet</p>
                      <p className="text-sm text-muted-foreground mt-1">Complete a practice session to see your history.</p>
                    </GlassCard>
                  ) : (
                    <div className="space-y-3">
                      {attempts.map((a: { id: string; attempt_type: string; total_questions: number; correct_count: number; accuracy: number | null; score: number; completed_at: string | null; created_at: string }) => (
                        <GlassCard key={a.id} className="p-4">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="font-medium text-foreground capitalize text-sm">{a.attempt_type.replace('_', ' ')}</p>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {a.total_questions} questions · {new Date(a.completed_at || a.created_at).toLocaleDateString()}
                              </p>
                            </div>
                            <div className="flex gap-4 text-center">
                              <div>
                                <p className="text-lg font-bold text-green-500">{a.correct_count}</p>
                                <p className="text-xs text-muted-foreground">Correct</p>
                              </div>
                              <div>
                                <p className="text-lg font-bold text-primary">{a.accuracy ?? '--'}%</p>
                                <p className="text-xs text-muted-foreground">Accuracy</p>
                              </div>
                            </div>
                          </div>
                        </GlassCard>
                      ))}
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </motion.div>
          )}

          {/* ── SESSION PHASE ── */}
          {phase === 'session' && currentQ && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
              {/* Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground">Question {currentIdx + 1} / {questions.length}</span>
                  <Badge variant="outline" className="capitalize text-xs">{currentQ.difficulty}</Badge>
                </div>
                <div className="flex items-center gap-3">
                  {mode === 'timed' && <TimerBadge seconds={elapsedSeconds} limit={timeLimitMinutes * 60} />}
                  <Button size="sm" variant="outline" onClick={() => handleFinishSession()} disabled={isSubmitting}>
                    {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Finish'}
                  </Button>
                </div>
              </div>

              <Progress value={((currentIdx + 1) / questions.length) * 100} className="h-1.5" />

              {/* Question card */}
              <GlassCard className="p-6">
                {currentQ.passage_text && (
                  <div className="mb-4 p-3 bg-muted/30 rounded-lg text-sm text-muted-foreground border border-border/30">
                    {currentQ.passage_text}
                  </div>
                )}
                <p className="text-foreground font-medium text-lg leading-relaxed mb-6">{currentQ.question_text}</p>
                {mode === 'practice' && !hasAnswered && (
                  <p className="text-xs text-muted-foreground mb-3">
                    Select an option, then submit your answer. Any selected answer is also included if you finish early.
                  </p>
                )}

                {/* MCQ options */}
                {['mcq', 'passage_mcq'].includes(currentQ.question_type) && currentQ.options && (
                  <div className="space-y-3">
                    {currentQ.options.map((opt) => {
                      const isSelected = selectedAnswer === opt.id;
                      const resp = responses[currentQ.id];
                      const isCorrect = isPracticeAnswerCorrect(currentQ, opt.id);
                      let optClass = 'border-border/50 hover:border-primary/50';
                      if (showExplanation || (hasAnswered && mode === 'timed')) {
                        if (isCorrect) optClass = 'border-green-500 bg-green-500/10 text-green-400';
                        else if (isSelected && !isCorrect) optClass = 'border-red-500 bg-red-500/10 text-red-400';
                      } else if (isSelected) {
                        optClass = 'border-primary bg-primary/10';
                      }
                      return (
                        <button
                          key={opt.id}
                          onClick={() => handleAnswerSelect(opt.id)}
                          disabled={hasAnswered && mode !== 'practice'}
                          className={`w-full text-left p-3 rounded-xl border glass transition-all text-sm ${optClass}`}
                        >
                          <span className="font-semibold mr-3">{opt.id}.</span>{opt.text}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Explanation (practice mode after answer) */}
                <AnimatePresence>
                  {showExplanation && currentQ.explanation && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mt-4 p-4 bg-blue-500/10 border border-blue-500/30 rounded-xl"
                    >
                      <p className="text-xs font-semibold text-blue-400 mb-1">Explanation</p>
                      <p className="text-sm text-foreground">{currentQ.explanation}</p>
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="flex gap-3 mt-6">
                  {!hasAnswered ? (
                    <>
                      <GlowButton onClick={handleSubmitAnswer} disabled={!selectedAnswer || isSubmitting} className="flex-1">Submit Answer</GlowButton>
                      <Button variant="outline" onClick={handleSkip} disabled={isSubmitting}>
                        <SkipForward className="w-4 h-4 mr-1" /> Skip Question
                      </Button>
                    </>
                  ) : (
                    <GlowButton onClick={handleNext} className="flex-1">
                      {currentIdx + 1 < questions.length ? (
                        <><ArrowRight className="w-4 h-4 mr-1" /> Next Question</>
                      ) : (
                        <><CheckCircle className="w-4 h-4 mr-1" /> Finish Session</>
                      )}
                    </GlowButton>
                  )}
                </div>
              </GlassCard>

              {/* Question palette */}
              <GlassCard className="p-4">
                <p className="text-xs text-muted-foreground mb-2">Question Palette</p>
                <div className="flex flex-wrap gap-2">
                  {questions.map((q, i) => {
                    const resp = responses[q.id];
                    const hasDraftAnswer = draftAnswersRef.current[q.id] !== undefined;
                    let cls = 'w-8 h-8 rounded-lg text-xs font-medium border transition-colors ';
                    if (resp === undefined && hasDraftAnswer) cls += 'border-blue-500/50 bg-blue-500/10 text-blue-400';
                    else if (resp === undefined) cls += i === currentIdx ? 'border-primary bg-primary/20 text-primary' : 'border-border/50 text-muted-foreground';
                    else if (resp.answer === null) cls += 'border-yellow-500/50 bg-yellow-500/10 text-yellow-400';
                    else cls += resp.isCorrect
                      ? 'border-green-500/50 bg-green-500/10 text-green-400'
                      : 'border-red-500/50 bg-red-500/10 text-red-400';
                    return <button
                      key={q.id}
                      className={cls}
                      onClick={() => {
                        setCurrentIdx(i);
                        setSelectedAnswer(draftAnswersRef.current[q.id] ?? null);
                        setShowExplanation(!!responsesRef.current[q.id] && mode === 'practice');
                      }}
                    >{i + 1}</button>;
                  })}
                </div>
              </GlassCard>
            </motion.div>
          )}

          {/* ── RESULTS PHASE ── */}
          {phase === 'results' && visibleResult && (
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
              <div className="text-center">
                <Award className="w-16 h-16 text-primary mx-auto mb-3" />
                <h1 className="font-display text-3xl font-bold text-foreground">Session Complete!</h1>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                {[
                  { label: 'Correct', value: visibleResult.correct, color: 'text-green-500' },
                  { label: 'Wrong', value: visibleResult.wrong, color: 'text-red-400' },
                  { label: 'Skipped', value: visibleResult.skipped, color: 'text-yellow-400' },
                  { label: 'Accuracy', value: `${visibleResult.accuracy}%`, color: 'text-primary' },
                  { label: 'Score', value: `${visibleResult.score} / ${visibleResult.maxScore}`, color: 'text-primary' },
                ].map(stat => (
                  <GlassCard key={stat.label} className="p-4 text-center">
                    <p className={`text-3xl font-bold ${stat.color}`}>{stat.value}</p>
                    <p className="text-xs text-muted-foreground mt-1">{stat.label}</p>
                  </GlassCard>
                ))}
              </div>

              {/* Per-question review */}
              <GlassCard className="p-5">
                <h2 className="font-semibold text-foreground mb-4">Review Questions</h2>
                <div className="space-y-4">
                  {visibleResult.questions.map((q, i) => {
                    const resp = visibleResult.responses[q.id];
                    const answered = resp?.answer !== null && resp?.answer !== undefined;
                    const isCorrect = resp?.isCorrect;
                    return (
                      <div key={q.id} className={`p-4 rounded-xl border ${isCorrect ? 'border-green-500/30 bg-green-500/5' : !answered ? 'border-yellow-500/30 bg-yellow-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
                        <div className="flex items-start gap-3">
                          {isCorrect ? <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" /> :
                           !answered ? <SkipForward className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" /> :
                           <XCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />}
                          <div className="flex-1">
                            <p className="text-sm font-medium text-foreground">{i + 1}. {q.question_text}</p>
                            {answered && (
                              <p className="text-xs text-muted-foreground mt-1">Your answer: <span className="text-foreground">{String(resp.answer)}</span></p>
                            )}
                            <p className="text-xs text-muted-foreground mt-0.5">Correct: <span className="text-green-400">{String(q.correct_answer)}</span></p>
                            {q.explanation && (
                              <p className="text-xs text-muted-foreground mt-2 p-2 bg-muted/20 rounded">{q.explanation}</p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </GlassCard>

              <div className="flex gap-3 justify-center">
                <Button variant="outline" onClick={() => { setPhase('home'); setActiveTab('practice'); }}>
                  <RefreshCw className="w-4 h-4 mr-2" /> Practice Again
                </Button>
                <GlowButton onClick={() => setPhase('home')}>
                  <Home className="w-4 h-4 mr-2" /> Dashboard
                </GlowButton>
              </div>
            </motion.div>
          )}

          {phase === 'results' && !visibleResult && (
            <GlassCard className="p-8 text-center" role="alert">
              <AlertCircle className="w-10 h-10 text-destructive mx-auto mb-3" />
              <h1 className="text-xl font-semibold text-foreground">Results are unavailable</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                The session ended, but its questions or answers are no longer available to display.
                Your attempt may still appear in History if it was saved.
              </p>
              <div className="mt-5 flex justify-center gap-3">
                <Button variant="outline" onClick={() => { setPhase('home'); setActiveTab('history'); }}>
                  View History
                </Button>
                <GlowButton onClick={() => { setPhase('home'); setActiveTab('practice'); }}>
                  Back to Practice
                </GlowButton>
              </div>
            </GlassCard>
          )}
        </div>
      </MainLayout>
    </>
  );
}
