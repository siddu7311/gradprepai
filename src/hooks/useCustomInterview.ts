import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';

export interface CustomQuestion {
  id?: string;
  question_text: string;
  expected_answer: string | null;
  evaluation_criteria: string | null;
  topic: string | null;
  skill_category: string | null;
  difficulty: string;
  question_type: string;
  source_page: string | null;
  display_order: number;
  tags: string[];
}

export interface CustomQuestionSet {
  id: string;
  title: string;
  description: string | null;
  processing_status: string;
  processing_error: string | null;
  target_role: string | null;
  subject: string | null;
  difficulty: string | null;
  language: string | null;
  is_archived: boolean;
  is_admin_set: boolean;
  is_published: boolean;
  question_count: number;
  created_at: string;
}

async function getCustomQuestionFunctionError(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body: unknown = await error.context.clone().json();
      if (typeof body === 'object' && body !== null && 'error' in body) {
        const message = (body as { error?: unknown }).error;
        if (typeof message === 'string' && message.trim()) return message;
      }
    } catch {
      // The function may return a non-JSON gateway error.
    }
  }

  return error instanceof Error ? error.message : 'Question processing failed.';
}

export function useCustomInterview() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const uploadAndProcess = useCallback(async (opts: {
    file: File;
    title: string;
    description?: string;
    target_role?: string;
    subject?: string;
    difficulty?: string;
    language?: string;
    question_count?: number;
    generate_from_material?: boolean;
  }) => {
    if (!user?.id) throw new Error('Not authenticated');

    setUploading(true);
    try {
      // 1. Upload file to private storage
      const ext = opts.file.name.split('.').pop()?.toLowerCase() || 'bin';
      const storagePath = `custom-questions/${user.id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from('documents')
        .upload(storagePath, opts.file, { upsert: false, contentType: opts.file.type });
      if (uploadError) {
        if (/bucket not found/i.test(uploadError.message)) {
          throw new Error(
            'The private documents bucket is missing from Supabase. Apply migration 20261025000000_custom_question_documents_bucket.sql, then retry.',
          );
        }
        throw new Error(`Upload failed: ${uploadError.message}`);
      }

      // 2. Create question set record
      const { data: setData, error: setError } = await supabase
        .from('custom_question_sets')
        .insert({
          user_id: user.id,
          title: opts.title,
          description: opts.description || null,
          source_file_path: storagePath,
          source_file_name: opts.file.name,
          source_file_type: opts.file.type,
          target_role: opts.target_role || null,
          subject: opts.subject || null,
          difficulty: opts.difficulty || 'intermediate',
          language: opts.language || 'English',
          processing_status: 'processing',
          is_admin_set: false,
        })
        .select()
        .single();
      if (setError) {
        const { error: cleanupError } = await supabase.storage.from('documents').remove([storagePath]);
        if (cleanupError) {
          console.error('Could not remove uploaded custom question source after record creation failed:', cleanupError);
        }
        throw new Error(`Failed to create record: ${setError.message}`);
      }

      setUploading(false);
      return { set_id: setData.id, storagePath };
    } catch (err) {
      setUploading(false);
      throw err;
    }
  }, [user?.id]);

  const processExtractedText = useCallback(async (opts: {
    set_id: string;
    extracted_text: string;
    target_role?: string;
    difficulty?: string;
    language?: string;
    question_count?: number;
    generate_from_material?: boolean;
  }) => {
    if (!user?.id) throw new Error('Not authenticated');
    setProcessing(true);

    try {
      const { error: statusError } = await supabase
        .from('custom_question_sets')
        .update({ processing_status: 'processing', processing_error: null })
        .eq('id', opts.set_id)
        .eq('user_id', user.id);
      if (statusError) throw new Error(`Could not start question processing: ${statusError.message}`);

      const { data, error } = await supabase.functions.invoke('process-custom-questions', {
        body: {
          set_id: opts.set_id,
          extracted_text: opts.extracted_text,
          target_role: opts.target_role || null,
          difficulty: opts.difficulty || 'intermediate',
          language: opts.language || 'English',
          question_count: opts.question_count || 10,
          generate_from_material: opts.generate_from_material ?? false,
        },
      });
      if (error) throw new Error(await getCustomQuestionFunctionError(error));
      if (data?.error) throw new Error(data.error);

      queryClient.invalidateQueries({ queryKey: ['custom_question_sets'] });
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Question processing failed.';
      const { error: statusError } = await supabase
        .from('custom_question_sets')
        .update({ processing_status: 'error', processing_error: message })
        .eq('id', opts.set_id)
        .eq('user_id', user.id);
      if (statusError) {
        console.error('Could not mark custom question set processing as failed:', statusError);
      }
      queryClient.invalidateQueries({ queryKey: ['custom_question_sets'] });
      throw new Error(message);
    } finally {
      setProcessing(false);
    }
  }, [user?.id, queryClient]);

  const saveManualQuestionSet = useCallback(async (opts: {
    title: string;
    description?: string;
    target_role?: string;
    difficulty?: string;
    language?: string;
    questions: Omit<CustomQuestion, 'id'>[];
  }) => {
    if (!user?.id) throw new Error('Not authenticated');
    const { data: setData, error: setError } = await supabase
      .from('custom_question_sets')
      .insert({
        user_id: user.id,
        title: opts.title,
        description: opts.description || null,
        target_role: opts.target_role || null,
        difficulty: opts.difficulty || 'intermediate',
        language: opts.language || 'English',
        processing_status: 'ready',
        is_admin_set: false,
        question_count: opts.questions.length,
      })
      .select().single();
    if (setError) throw new Error(setError.message);

    const rows = opts.questions.map((q, i) => ({
      ...q, set_id: setData.id, user_id: user.id, display_order: i,
    }));
    const { error: qError } = await supabase.from('custom_questions').insert(rows);
    if (qError) throw new Error(qError.message);

    queryClient.invalidateQueries({ queryKey: ['custom_question_sets'] });
    return setData;
  }, [user?.id, queryClient]);

  const updateSet = useCallback(async (set_id: string, updates: { title?: string; description?: string; is_archived?: boolean }) => {
    const { error } = await supabase.from('custom_question_sets').update(updates).eq('id', set_id);
    if (error) throw new Error(error.message);
    queryClient.invalidateQueries({ queryKey: ['custom_question_sets'] });
  }, [queryClient]);

  const deleteSet = useCallback(async (set_id: string) => {
    const { error } = await supabase.from('custom_question_sets').delete().eq('id', set_id);
    if (error) throw new Error(error.message);
    queryClient.invalidateQueries({ queryKey: ['custom_question_sets'] });
  }, [queryClient]);

  const updateQuestions = useCallback(async (set_id: string, questions: CustomQuestion[]) => {
    if (!user?.id) throw new Error('Not authenticated');
    const { error: deleteError } = await supabase.from('custom_questions').delete().eq('set_id', set_id);
    if (deleteError) throw new Error(deleteError.message);
    const rows = questions.map((q, i) => ({
      set_id,
      user_id: user.id,
      question_text: q.question_text,
      expected_answer: q.expected_answer,
      evaluation_criteria: q.evaluation_criteria,
      topic: q.topic,
      skill_category: q.skill_category,
      difficulty: q.difficulty,
      question_type: q.question_type,
      source_page: q.source_page,
      display_order: i,
      tags: q.tags,
    }));
    const { error } = await supabase.from('custom_questions').insert(rows);
    if (error) throw new Error(error.message);
    const { error: setError } = await supabase
      .from('custom_question_sets')
      .update({ question_count: questions.length })
      .eq('id', set_id);
    if (setError) throw new Error(setError.message);
    queryClient.invalidateQueries({ queryKey: ['custom_question_sets'] });
    queryClient.invalidateQueries({ queryKey: ['custom_questions', set_id] });
  }, [user?.id, queryClient]);

  return {
    uploading,
    processing,
    uploadAndProcess,
    processExtractedText,
    saveManualQuestionSet,
    updateSet,
    deleteSet,
    updateQuestions,
  };
}
