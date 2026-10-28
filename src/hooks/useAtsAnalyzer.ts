import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useQueryClient } from '@tanstack/react-query';
import { getSupabaseFunctionErrorMessage } from '@/lib/supabaseFunctionError';

export interface AtsAnalysisResult {
  id?: string;
  ats_readiness_score: number;
  jd_match_score: number;
  parsing_status: string;
  parsing_issues: string[];
  strong_points: string[];
  critical_issues: string[];
  formatting_warnings: string[];
  missing_sections: string[];
  required_keywords_found: string[];
  required_keywords_missing: string[];
  preferred_keywords_found: string[];
  skills_to_highlight: string[];
  recommendations: Array<{
    priority: 'high' | 'medium' | 'optional';
    category: string;
    message: string;
    example: string | null;
  }>;
  contact_info_detected: Record<string, boolean>;
  sections_detected: string[];
  quantified_achievements_count: number;
  grammar_issues: string[];
  score_rationale: { ats_readiness: string; jd_match: string };
  created_at?: string;
}

export function useAtsAnalyzer() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const analyze = useCallback(async (opts: {
    resume_text: string;
    resume_file_name?: string;
    parent_analysis_id?: string;
  }): Promise<AtsAnalysisResult> => {
    if (!user?.id) throw new Error('Not authenticated');
    setAnalyzing(true);
    setError(null);

    try {
      const { data, error: fnError } = await supabase.functions.invoke('ats-analyze-resume', {
        body: {
          resume_text: opts.resume_text,
        },
      });
      if (fnError) throw new Error(await getSupabaseFunctionErrorMessage(fnError));
      if (data?.error) throw new Error(data.error);
      if (
        typeof data !== 'object' ||
        data === null ||
        typeof data.ats_readiness_score !== 'number' ||
        !Number.isFinite(data.ats_readiness_score)
      ) {
        throw new Error('The ATS analysis returned an incomplete result. Please try again.');
      }

      const analysis: AtsAnalysisResult = {
        ...data,
        parsing_status: typeof data.parsing_status === 'string' ? data.parsing_status : 'ok',
        parsing_issues: Array.isArray(data.parsing_issues) ? data.parsing_issues : [],
        strong_points: Array.isArray(data.strong_points) ? data.strong_points : [],
        critical_issues: Array.isArray(data.critical_issues) ? data.critical_issues : [],
        formatting_warnings: Array.isArray(data.formatting_warnings) ? data.formatting_warnings : [],
        missing_sections: Array.isArray(data.missing_sections) ? data.missing_sections : [],
        required_keywords_found: Array.isArray(data.required_keywords_found) ? data.required_keywords_found : [],
        required_keywords_missing: Array.isArray(data.required_keywords_missing) ? data.required_keywords_missing : [],
        preferred_keywords_found: Array.isArray(data.preferred_keywords_found) ? data.preferred_keywords_found : [],
        skills_to_highlight: Array.isArray(data.skills_to_highlight) ? data.skills_to_highlight : [],
        recommendations: Array.isArray(data.recommendations) ? data.recommendations : [],
        contact_info_detected:
          typeof data.contact_info_detected === 'object' && data.contact_info_detected !== null
            ? data.contact_info_detected
            : {},
        sections_detected: Array.isArray(data.sections_detected) ? data.sections_detected : [],
        quantified_achievements_count:
          typeof data.quantified_achievements_count === 'number' ? data.quantified_achievements_count : 0,
        grammar_issues: Array.isArray(data.grammar_issues) ? data.grammar_issues : [],
        score_rationale:
          typeof data.score_rationale === 'object' && data.score_rationale !== null
            ? {
                ats_readiness:
                  typeof data.score_rationale.ats_readiness === 'string'
                    ? data.score_rationale.ats_readiness
                    : 'ATS readiness was evaluated from the resume content.',
                jd_match:
                  typeof data.score_rationale.jd_match === 'string'
                    ? data.score_rationale.jd_match
                    : 'Job matching was not evaluated.',
              }
            : {
                ats_readiness: 'ATS readiness was evaluated from the resume content.',
                jd_match: 'Job matching was not evaluated.',
              },
      };

      // Persist analysis record
      const recordPayload = {
        user_id: user.id,
        resume_file_name: opts.resume_file_name || null,
        resume_text: opts.resume_text.slice(0, 8000),
        ats_readiness_score: analysis.ats_readiness_score,
        jd_match_score: analysis.jd_match_score ?? null,
        parsing_status: analysis.parsing_status,
        parsing_issues: analysis.parsing_issues,
        strong_points: analysis.strong_points,
        critical_issues: analysis.critical_issues,
        formatting_warnings: analysis.formatting_warnings,
        missing_sections: analysis.missing_sections,
        required_keywords_found: analysis.required_keywords_found,
        required_keywords_missing: analysis.required_keywords_missing,
        preferred_keywords_found: analysis.preferred_keywords_found,
        skills_to_highlight: analysis.skills_to_highlight,
        recommendations: analysis.recommendations,
        parent_analysis_id: opts.parent_analysis_id || null,
      };

      const { data: saved, error: saveError } = await supabase
        .from('ats_analyses')
        .insert(recordPayload)
        .select()
        .single();

      if (saveError) console.warn('Failed to save ATS analysis:', saveError.message);

      queryClient.invalidateQueries({ queryKey: ['ats_analyses', user.id] });
      return { ...analysis, id: saved?.id };
    } catch (err) {
      const msg = await getSupabaseFunctionErrorMessage(err);
      setError(msg);
      throw new Error(msg);
    } finally {
      setAnalyzing(false);
    }
  }, [user?.id, queryClient]);

  return { analyzing, error, analyze };
}
