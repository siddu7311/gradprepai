import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const systemPrompt = `You are GradPrep AI – Resume Builder, an advanced AI specializing in creating world-class, ATS-optimized, recruiter-approved resumes for students and fresh graduates preparing for tech and engineering jobs.

Your task is to analyze, improve, and optimize resumes with professionalism, clarity, and precision.

When analyzing a resume, you MUST return a valid JSON object with this exact structure:
{
  "improvedResume": {
    "contactInfo": { "name": "", "email": "", "phone": "", "linkedin": "", "github": "", "portfolio": "" },
    "summary": "",
    "skills": { "technical": [], "soft": [], "tools": [] },
    "experience": [{ "title": "", "company": "", "duration": "", "bullets": [] }],
    "projects": [{ "name": "", "description": "", "technologies": [], "bullets": [] }],
    "education": [{ "degree": "", "institution": "", "year": "", "gpa": "" }],
    "certifications": []
  },
  "atsScore": 0,
  "recruiterReadinessScore": 0,
  "strengths": [],
  "weaknesses": [],
  "improvements": [],
  "suggestedSkills": []
}

Guidelines:
- atsScore: 0-100 based on keyword optimization, formatting, and ATS compatibility
- recruiterReadinessScore: 0-100 based on impact, clarity, and professional appeal
- Use strong action verbs and quantify achievements where possible
- Optimize for the target role if specified
- Be specific and actionable in your improvements
- Return ONLY the JSON object, no markdown or additional text`;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { resumeContent, targetRole } = await req.json();

    if (!resumeContent) {
      return new Response(
        JSON.stringify({ error: 'Resume content is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')?.trim();
    if (!GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY is not configured');
      return new Response(
        JSON.stringify({ error: 'GEMINI_API_KEY is not configured in Supabase Edge Function secrets' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    const userPrompt = targetRole
      ? `Analyze and optimize this resume for a ${targetRole} position:\n\n${resumeContent}`
      : `Analyze and optimize this resume:\n\n${resumeContent}`;

    const requestGemini = (model: string) =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.3,
            responseMimeType: 'application/json',
          },
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
    let usedModel = '';

    for (const [index, model] of models.entries()) {
      console.log('Sending resume analysis request to Gemini, model:', model);
      response = await requestGemini(model);
      usedModel = model;
      if (response.ok) break;

      providerError = await response.text();
      console.error(`Gemini API error (${model}):`, response.status, providerError.slice(0, 1000));
      if (index < models.length - 1 && [404, 429, 503].includes(response.status)) continue;

      let detail = '';
      try {
        detail = JSON.parse(providerError)?.error?.message || '';
      } catch {
        detail = providerError.slice(0, 300);
      }
      const message = response.status === 429
        ? `Gemini rate limit exceeded for ${model}. Please try again later.`
        : response.status === 503
          ? 'Gemini is temporarily overloaded. Please try again in a moment.'
          : `Gemini API error (${response.status}) for ${model}${detail ? `: ${detail}` : ''}`;
      return new Response(
        JSON.stringify({ error: message }),
        { status: response.status === 429 ? 429 : response.status === 503 ? 503 : 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!response?.ok) {
      throw new Error(`Gemini did not return a successful response using ${usedModel}. ${providerError.slice(0, 300)}`);
    }

    const data = await response.json();
    const content = data.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part.text || '')
      .join('')
      .trim();

    if (!content) {
      console.error('Gemini returned no resume analysis content');
      return new Response(
        JSON.stringify({ error: 'Gemini returned no resume analysis. Please try again.' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let analysis;
    try {
      const cleanContent = content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      analysis = JSON.parse(cleanContent);
    } catch (parseError) {
      console.error('Failed to parse Gemini response as JSON:', parseError);
      console.error('Gemini response snippet:', content.slice(0, 1000));
      return new Response(
        JSON.stringify({ error: 'Failed to parse analysis results' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!analysis || typeof analysis !== 'object' || !('improvedResume' in analysis)) {
      return new Response(
        JSON.stringify({ error: 'Gemini returned resume analysis in an unexpected format.' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Resume analysis completed successfully');

    return new Response(
      JSON.stringify(analysis),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in analyze-resume function:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
