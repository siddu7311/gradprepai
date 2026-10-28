import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PERSONA_PROMPTS = {
  amds: `You are AMDS, a professional male AI interviewer. You are:
- Direct and technical-focused
- Ask precise, challenging questions
- Provide concise feedback
- Maintain a formal but supportive tone
- Focus on problem-solving and technical depth`,

  lusy: `You are LUSY, a friendly female AI interviewer. You are:
- Warm and encouraging
- Ask thorough, well-structured questions
- Provide detailed, constructive feedback
- Create a comfortable interview environment
- Balance technical questions with behavioral ones`
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const {
      role,
      language,
      difficulty,
      persona,
      questionCount = 5,
      previousQuestions = [],
      seed,
    } = await req.json() as {
      role: string;
      language: string;
      difficulty: string;
      persona: keyof typeof PERSONA_PROMPTS;
      questionCount?: number;
      previousQuestions?: string[];
      seed?: string;
    };

    console.log('Generating interview questions for:', { role, language, difficulty, persona, questionCount });

    const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')?.trim();
    if (!GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not configured in Supabase Edge Function secrets');
    }
    const GEMINI_MODEL = 'gemini-3.8-flash';
    const FALLBACK_GEMINI_MODEL = 'gemini-3.1-flash-lite';

    const personaPrompt = PERSONA_PROMPTS[persona] || PERSONA_PROMPTS.lusy;

    const difficultyDescriptions: Record<string, string> = {
      beginner: 'basic concepts, fundamentals, and entry-level knowledge',
      intermediate: 'practical problems, best practices, and real-world scenarios',
      advanced: 'complex system design, architecture decisions, and advanced concepts'
    };

    const focusAreas = [
      'core language semantics and gotchas',
      'data structures and algorithmic thinking',
      'debugging a real production incident',
      'API and interface design trade-offs',
      'testing strategy and code quality',
      'performance profiling and optimisation',
      'concurrency, async behaviour or scheduling',
      'memory / resource management',
      'security and input validation',
      'system design and scalability',
      'tooling, build and deployment workflow',
      'refactoring legacy code',
      'collaboration and code review behaviour',
      'data modelling and persistence',
      'error handling and observability',
    ];
    const shuffled = [...focusAreas].sort(() => Math.random() - 0.5).slice(0, Math.max(3, questionCount));

    const systemPrompt = `${personaPrompt}

You generate interview questions in JSON format only. No markdown, no extra text.
You never repeat questions you have been told to avoid, and you never reuse stock/templated openers.`;

    const userPrompt = `Generate ${questionCount} DISTINCT interview questions for a ${role} position focusing on ${language}.
The difficulty level is ${difficulty} (${difficultyDescriptions[difficulty] || difficultyDescriptions.intermediate}).

Session variety token (use it to make this set unique): ${seed || crypto.randomUUID()}
Cover a different focus area per question, drawn from: ${shuffled.join('; ')}.
Each question must be specific and ${language}-flavoured — reference concrete ${language} features, tools, or scenarios rather than generic phrasing.
${previousQuestions.length ? `DO NOT ask any of these previously asked questions, or close paraphrases of them:\n- ${previousQuestions.slice(-40).join('\n- ')}` : ''}

Format your response as a JSON array of objects with the following structure:
[
  {
    "question": "The interview question text",
    "followUp": "A potential follow-up question",
    "hints": ["hint1", "hint2"],
    "expectedTopics": ["topic1", "topic2"]
  }
]

Make questions conversational and appropriate for a ${persona === 'amds' ? 'direct, technical' : 'friendly, encouraging'} interview style.
Only respond with the JSON array, no other text.`;

    console.log('Sending interview question request to Gemini, model:', GEMINI_MODEL);

    const requestGeneration = (model: string) =>
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
            temperature: 1.0,
            responseMimeType: 'application/json',
          },
        }),
      });

    let response = await requestGeneration(GEMINI_MODEL);
    let usedModel = GEMINI_MODEL;

    if (response.status === 503) {
      const primaryError = await response.text();
      console.warn(
        `Gemini model ${GEMINI_MODEL} is temporarily overloaded; trying ${FALLBACK_GEMINI_MODEL}:`,
        primaryError.slice(0, 500),
      );
      usedModel = FALLBACK_GEMINI_MODEL;
      response = await requestGeneration(FALLBACK_GEMINI_MODEL);

      for (let retry = 0; response.status === 503 && retry < 2; retry += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (retry + 1)));
        response = await requestGeneration(FALLBACK_GEMINI_MODEL);
      }
    }

    console.log('Gemini question request completed with model:', usedModel);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini API Error:', response.status, errorText.slice(0, 1000));
      if (response.status === 429) throw new Error('Gemini rate limit exceeded. Please try again later.');
      let detail = '';
      try {
        detail = JSON.parse(errorText)?.error?.message || '';
      } catch {
        detail = errorText.slice(0, 300);
      }
      if (response.status === 404) {
        throw new Error(
          `Gemini model "${usedModel}" was not found. Check that the Gemini API is enabled for the project that owns GEMINI_API_KEY.${detail ? ` ${detail}` : ''}`,
        );
      }
      if (response.status === 503) {
        throw new Error('Gemini is temporarily overloaded. Please wait a moment and try again.');
      }
      throw new Error(`Gemini API error (${response.status})${detail ? `: ${detail}` : ''}`);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    const content = candidate?.content?.parts
      ?.map((part: { text?: string }) => part.text || '')
      .join('')
      .trim();

    if (!content) {
      console.error('Gemini returned no usable content:', JSON.stringify(data).slice(0, 1000));
      const reason = candidate?.finishReason;
      throw new Error(
        reason
          ? `Gemini did not generate questions (finish reason: ${reason}). Please try again.`
          : 'Gemini returned no interview questions. Please try again.',
      );
    }

    console.log('Gemini response received, parsing questions...');

    let questions;
    try {
      const cleanContent = content.replace(/```json\n?|\n?```/g, '').trim();
      questions = JSON.parse(cleanContent);
    } catch {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        questions = JSON.parse(jsonMatch[0]);
      } else {
        console.error('Failed to parse Gemini questions response:', content.slice(0, 1000));
        throw new Error('Failed to parse interview questions from Gemini.');
      }
    }

    if (!Array.isArray(questions) || questions.length === 0 ||
        questions.some((question: { question?: unknown }) => typeof question?.question !== 'string' || !question.question.trim())) {
      throw new Error('Gemini returned interview questions in an unexpected format.');
    }

    console.log('Successfully generated', questions.length, 'questions');

    return new Response(
      JSON.stringify({ questions, persona, role, difficulty, success: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    console.error('Question Generation Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
