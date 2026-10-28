import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const systemPrompt = `You are an ATS (Applicant Tracking System) resume analysis expert for GradPrep AI.
Analyze the provided resume against the job description and return a structured JSON response.
You are strict, honest, and specific. You NEVER invent skills, experience, degrees, or achievements not present in the resume.
You NEVER guarantee ATS passage or interviews — your scores are estimates.
Reply with valid JSON only. No markdown.`;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { resume_text } = await req.json();

    if (!resume_text?.trim()) {
      return new Response(JSON.stringify({ error: 'resume_text is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')?.trim();
    if (!GEMINI_API_KEY) {
      return new Response(JSON.stringify({ error: 'GEMINI_API_KEY is not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const trimmedResume = resume_text.slice(0, 8000);

    const userPrompt = `Analyze this resume for general ATS readiness. Use only evidence in the resume. Do not compare it to a job, company, job description, or assumed experience level.

RESUME:
"""
${trimmedResume}
"""

Return this exact JSON structure:
{
  "ats_readiness_score": <0-100, ATS parsing & formatting score>,
  "jd_match_score": 50,
  "parsing_status": "ok|partial|failed",
  "parsing_issues": ["issue1"],
  "strong_points": ["point1"],
  "critical_issues": ["issue1"],
  "formatting_warnings": ["warning1"],
  "missing_sections": ["section1"],
  "required_keywords_found": ["keyword1"],
  "required_keywords_missing": ["keyword1"],
  "preferred_keywords_found": ["keyword1"],
  "skills_to_highlight": ["skill1"],
  "recommendations": [
    {
      "priority": "high|medium|optional",
      "category": "formatting|keywords|content|structure|achievements",
      "message": "Specific recommendation",
      "example": "Example improvement or null"
    }
  ],
  "contact_info_detected": {"name": true, "email": true, "phone": true, "linkedin": false},
  "sections_detected": ["summary", "experience", "education", "skills"],
  "quantified_achievements_count": <integer>,
  "grammar_issues": ["issue1"],
  "score_rationale": {
    "ats_readiness": "Brief explanation of ATS readiness score",
    "jd_match": "Not evaluated because this analysis focuses on general ATS readiness"
  }
}

Scoring guidelines:
- ats_readiness_score: formatting clarity (30%), section completeness (25%), text parseability (25%), no problematic elements (20%)
- Set jd_match_score to exactly 50 as a neutral compatibility value; do not calculate a job-match score
- Set required_keywords_found, required_keywords_missing, and preferred_keywords_found to empty arrays because no job description is provided
- Make recommendations specific, actionable changes the user can make to this resume to improve general ATS readability and completeness
- Give examples that clarify how to revise resume wording without inventing skills, experience, or achievements
- Never score above 95 — no resume is perfect
- Be honest: missing sections, sparse content, and poor formatting should lower scores significantly
- Do not recommend keyword stuffing or adding unsupported skills
- Do not invent or confirm skills the resume doesn't mention
- Clearly distinguish confirmed issues from possible risks`;

    const callGemini = (model: string) =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
        }),
      });

    const models = [
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash',
    ];
    let response: Response | null = null;
    let providerError = '';
    let modelUsed = '';

    for (const [index, model] of models.entries()) {
      response = await callGemini(model);
      modelUsed = model;
      if (response.ok) break;

      providerError = await response.text();
      console.error('Gemini ATS error:', {
        model,
        status: response.status,
        details: providerError.slice(0, 500),
      });

      if (index < models.length - 1 && [404, 429, 503].includes(response.status)) continue;

      let detail = '';
      try {
        detail = JSON.parse(providerError)?.error?.message || '';
      } catch {
        detail = providerError.slice(0, 300);
      }
      const msg = response.status === 429
        ? `Gemini rate limit exceeded for ${model}. Please try again later.`
        : response.status === 503
          ? 'Gemini is temporarily unavailable. Please try again in a moment.'
          : `Gemini API error (${response.status}) for ${model}${detail ? `: ${detail}` : ''}`;
      return new Response(JSON.stringify({ error: msg }), {
        status: response.status === 429 ? 429 : response.status === 503 ? 503 : 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!response?.ok) {
      throw new Error(`Gemini did not return a successful response using ${modelUsed}. ${providerError.slice(0, 300)}`);
    }

    const data = await response.json();
    const content = data.candidates?.[0]?.content?.parts?.map((p: {text?: string}) => p.text || '').join('').trim();
    if (!content) {
      return new Response(JSON.stringify({ error: 'Gemini returned no analysis' }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let analysis;
    try {
      analysis = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) analysis = JSON.parse(match[0]);
      else throw new Error('Failed to parse ATS analysis');
    }

    if (!analysis || typeof analysis.ats_readiness_score !== 'number') {
      throw new Error('Gemini returned ATS analysis in unexpected format');
    }

    return new Response(JSON.stringify({ ...analysis, success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('ats-analyze-resume error:', err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
