import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useQueryClient } from '@tanstack/react-query';
import {
  calculatePracticeResults,
  describeAptitudeGenerationError,
  filterUsablePracticeQuestions,
  isPracticeAnswerCorrect,
  normalizeGeneratedOptions,
  normalizeQuestionForPractice,
  type PracticeResponse,
} from '@/lib/aptitudePractice';

export interface AptitudeQuestion {
  id: string;
  topic_id: string;
  category_id: string;
  question_text: string;
  question_type: string;
  options: Array<{ id: string; text: string }> | null;
  correct_answer: string | string[];
  explanation: string | null;
  difficulty: string;
  marks: number;
  negative_marks: number;
  time_limit_seconds: number | null;
  passage_text: string | null;
  tags: string[] | null;
}

export interface AptitudeAttempt {
  id: string;
  attempt_type: string;
  total_questions: number;
  answered_count: number;
  correct_count: number;
  wrong_count: number;
  skipped_count: number;
  score: number;
  max_score: number;
  accuracy: number | null;
  time_taken_seconds: number | null;
  status: string;
  started_at: string;
  completed_at: string | null;
}

export function useAptitude() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);

  const startAttempt = useCallback(async (opts: {
    attempt_type: string;
    category_id?: string;
    topic_id?: string;
    questions: AptitudeQuestion[];
    time_limit_seconds?: number;
  }): Promise<string> => {
    if (!user?.id) throw new Error('Not authenticated');

    // AI-generated questions have synthetic ids (ai-xxx) — not real UUIDs.
    // Store only real UUID question ids to avoid DB constraint errors.
    const realUuidIds = opts.questions
      .map(q => q.id)
      .filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));

    const { data, error } = await supabase
      .from('aptitude_attempts')
      .insert({
        user_id: user.id,
        attempt_type: opts.attempt_type,
        category_id: opts.category_id || null,
        topic_id: opts.topic_id || null,
        question_ids: realUuidIds,
        total_questions: opts.questions.length,
        max_score: opts.questions.reduce((sum, q) => sum + q.marks, 0),
        time_limit_seconds: opts.time_limit_seconds || null,
        status: 'in_progress',
      })
      .select().single();

    if (error) throw new Error(error.message);
    return data.id;
  }, [user?.id]);

  const submitResponse = useCallback(async (opts: {
    attempt_id: string;
    question: AptitudeQuestion;
    user_answer: string | string[] | null;
    time_taken_seconds?: number;
  }) => {
    if (!user?.id) return;

    const isCorrect = isPracticeAnswerCorrect(opts.question, opts.user_answer);

    const marksEarned = isCorrect
      ? opts.question.marks
      : opts.user_answer !== null
        ? -opts.question.negative_marks
        : 0;

    // AI-generated questions have synthetic ids — skip the FK-constrained insert
    const isRealUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opts.question.id);
    if (isRealUuid) {
      const { error } = await supabase.from('aptitude_responses').insert({
        attempt_id: opts.attempt_id,
        user_id: user.id,
        question_id: opts.question.id,
        user_answer: opts.user_answer !== null ? opts.user_answer : null,
        is_correct: opts.user_answer !== null ? isCorrect : null,
        marks_earned: marksEarned,
        time_taken_seconds: opts.time_taken_seconds || null,
        answered_at: new Date().toISOString(),
      });
      if (error) throw new Error(`Unable to save your answer: ${error.message}`);
    }

    return { isCorrect, marksEarned };
  }, [user?.id]);

  const completeAttempt = useCallback(async (
    attempt_id: string,
    questions: AptitudeQuestion[],
    responses: Record<string, PracticeResponse>,
  ) => {
    if (!user?.id) return;

    const result = calculatePracticeResults(questions, responses);

    const { data: attempt, error: attemptError } = await supabase
      .from('aptitude_attempts')
      .select('total_questions, started_at, topic_id')
      .eq('id', attempt_id).single();
    if (attemptError) throw new Error(`Unable to load the practice attempt: ${attemptError.message}`);

    const now = new Date();
    const startedAt = new Date(attempt.started_at);
    const timeTaken = Math.round((now.getTime() - startedAt.getTime()) / 1000);

    const { data: updatedAttempt, error: updateError } = await supabase.from('aptitude_attempts').update({
      correct_count: result.correct,
      wrong_count: result.wrong,
      skipped_count: result.skipped,
      answered_count: result.correct + result.wrong,
      score: result.score,
      accuracy: result.accuracy,
      time_taken_seconds: timeTaken,
      status: 'completed',
      completed_at: now.toISOString(),
    }).eq('id', attempt_id).select('id').maybeSingle();
    if (updateError) throw new Error(`Unable to save the completed practice attempt: ${updateError.message}`);
    if (!updatedAttempt) throw new Error('Unable to save the completed practice attempt: no matching attempt was updated.');

    queryClient.invalidateQueries({ queryKey: ['aptitude_attempts'] });

    // Update topic performance (upsert) if we have topic info
    if (attempt.topic_id) {
      try {
        const { data: existing, error: performanceError } = await supabase
          .from('aptitude_topic_performance')
          .select('*')
          .eq('user_id', user.id)
          .eq('topic_id', attempt.topic_id)
          .maybeSingle();
        if (performanceError) throw performanceError;

        const newTotal = (existing?.total_questions || 0) + questions.length;
        const newCorrect = (existing?.correct_count || 0) + result.correct;
        const newAcc = newTotal > 0 ? Math.round((newCorrect / newTotal) * 100) : 0;

        const { error: upsertError } = await supabase.from('aptitude_topic_performance').upsert({
          user_id: user.id,
          topic_id: attempt.topic_id,
          total_attempts: (existing?.total_attempts || 0) + 1,
          total_questions: newTotal,
          correct_count: newCorrect,
          accuracy: newAcc,
          last_attempted_at: now.toISOString(),
        }, { onConflict: 'user_id,topic_id' });
        if (upsertError) throw upsertError;
      } catch (error) {
        console.error('Unable to update aptitude topic performance:', error);
      }
    }

    return result;
  }, [user?.id, queryClient]);

  /** Convert an AI-generated question object into the AptitudeQuestion shape. */
  const aiQuestionToAptitude = (q: Record<string, unknown>, topicId: string, categoryId: string): AptitudeQuestion => {
    const { options, correctAnswer } = normalizeGeneratedOptions(q.options, q.correct_answer);
    return {
      id: `ai-${Math.random().toString(36).slice(2)}`,
      topic_id: topicId,
      category_id: categoryId,
      question_text: String(q.question_text || ''),
      question_type: String(q.question_type || 'mcq'),
      options,
      correct_answer: correctAnswer,
      explanation: q.explanation ? String(q.explanation) : null,
      difficulty: String(q.difficulty || 'medium'),
      marks: typeof q.marks === 'number' ? q.marks : 1,
      negative_marks: typeof q.negative_marks === 'number' ? q.negative_marks : 0,
      time_limit_seconds: null,
      passage_text: null,
      tags: Array.isArray(q.tags) ? q.tags.map(String) : [],
    };
  };

  const loadQuestionsForTopic = useCallback(async (opts: {
    topic_id: string;
    category_id?: string;
    topic_name?: string;
    category_name?: string;
    difficulty?: string;
    count?: number;
  }): Promise<AptitudeQuestion[]> => {
    setLoading(true);
    try {
      const count = opts.count || 10;
      let query = supabase
        .from('aptitude_questions')
        .select('*')
        .eq('topic_id', opts.topic_id)
        .eq('is_published', true);

      if (opts.difficulty) query = query.eq('difficulty', opts.difficulty);
      const { data, error } = await query.limit(count * 3);
      if (error) throw new Error(error.message);
      const databaseQuestions = filterUsablePracticeQuestions((data || []) as unknown as AptitudeQuestion[]);
      if (databaseQuestions.length >= count) return databaseQuestions.slice(0, count);

      if (!opts.topic_name) return databaseQuestions;
      const { data: aiData, error: aiErr } = await supabase.functions.invoke('aptitude-generate-questions', {
        body: {
          topic_name: opts.topic_name,
          category_name: opts.category_name || '',
          difficulty: opts.difficulty || 'medium',
          count: count - databaseQuestions.length,
        },
      });
      if (aiErr) {
        console.error('Aptitude question-generation Edge Function failed:', {
          name: aiErr.name,
          message: aiErr.message,
          status: aiErr.context instanceof Response ? aiErr.context.status : undefined,
        });
        if (databaseQuestions.length > 0) {
          console.warn('Using valid published questions because generation failed.');
          return databaseQuestions;
        }
        throw new Error(await describeAptitudeGenerationError(aiErr));
      }
      if (aiData?.error) {
        if (databaseQuestions.length > 0) return databaseQuestions;
        throw new Error(aiData.error);
      }
      const qs = (aiData?.questions || []) as Record<string, unknown>[];
      const generatedQuestions = filterUsablePracticeQuestions(qs.map(q => normalizeQuestionForPractice(
        aiQuestionToAptitude(q, opts.topic_id, opts.category_id || ''),
      )));
      return [...databaseQuestions, ...generatedQuestions].slice(0, count);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadQuestionsForCategories = useCallback(async (opts: {
    category_ids: string[];
    category_name?: string;
    topic_name?: string;
    difficulty?: string;
    count?: number;
  }): Promise<AptitudeQuestion[]> => {
    setLoading(true);
    try {
      const count = opts.count || 20;
      let query = supabase
        .from('aptitude_questions')
        .select('*')
        .in('category_id', opts.category_ids)
        .eq('is_published', true);

      if (opts.difficulty) query = query.eq('difficulty', opts.difficulty);
      const { data, error } = await query.limit(count * 3);
      if (error) throw new Error(error.message);

      const databaseQuestions = filterUsablePracticeQuestions((data || []) as unknown as AptitudeQuestion[])
        .sort(() => Math.random() - 0.5)
        .slice(0, count);
      if (databaseQuestions.length >= count) return databaseQuestions;

      if (!opts.category_name) return databaseQuestions;
      const { data: aiData, error: aiErr } = await supabase.functions.invoke('aptitude-generate-questions', {
        body: {
          topic_name: opts.topic_name || opts.category_name,
          category_name: opts.category_name,
          difficulty: opts.difficulty || 'medium',
          count: count - databaseQuestions.length,
        },
      });
      if (aiErr) {
        console.error('Aptitude question-generation Edge Function failed:', {
          name: aiErr.name,
          message: aiErr.message,
          status: aiErr.context instanceof Response ? aiErr.context.status : undefined,
        });
        if (databaseQuestions.length > 0) {
          console.warn('Using valid published questions because generation failed.');
          return databaseQuestions;
        }
        throw new Error(await describeAptitudeGenerationError(aiErr));
      }
      if (aiData?.error) {
        if (databaseQuestions.length > 0) return databaseQuestions;
        throw new Error(aiData.error);
      }
      const qs = (aiData?.questions || []) as Record<string, unknown>[];
      const generatedQuestions = filterUsablePracticeQuestions(qs.map(q => normalizeQuestionForPractice(
        aiQuestionToAptitude(q, '', opts.category_ids[0] || ''),
      )));
      return [...databaseQuestions, ...generatedQuestions].slice(0, count);
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    loading,
    startAttempt,
    submitResponse,
    completeAttempt,
    loadQuestionsForTopic,
    loadQuestionsForCategories,
  };
}
