import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PERSONA_FEEDBACK_STYLES = {
  amds: `Provide feedback in a direct, technical style. Be concise but thorough. Focus on:
- Technical accuracy
- Code quality considerations
- Performance implications
- Best practices`,

  lusy: `Provide feedback in a warm, encouraging style. Be supportive but honest. Focus on:
- What was done well
- Areas for improvement
- Practical suggestions
- Encouragement for continued learning`
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { question, answer, persona, role, expectedTopics } = await req.json() as {
      question: string;
      answer: string;
      persona: keyof typeof PERSONA_FEEDBACK_STYLES;
      role: string;
      expectedTopics?: string[];
    };

    console.log('Analyzing interview response for:', { role, persona });

    const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')?.trim();
    if (!GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not configured in Supabase Edge Function secrets');
    }
    const primaryModel = 'gemini-3.8-flash';
    const fallbackModel = 'gemini-3.1-flash-lite';

    const feedbackStyle = PERSONA_FEEDBACK_STYLES[persona] || PERSONA_FEEDBACK_STYLES.lusy;

    const trimmedAnswer = (answer || '').trim();
    const wordCount = trimmedAnswer ? trimmedAnswer.split(/\s+/).length : 0;

    // Hard guard: never award marks for a missing or non-answer.
    if (wordCount < 3) {
      return new Response(
        JSON.stringify({
          score: 0,
          technicalScore: 0,
          communicationScore: 0,
          problemSolvingScore: 0,
          confidenceScore: 0,
          feedback: "I didn't catch an answer for that one, so I can't score it. Take a moment and give it another try.",
          strengths: [],
          improvements: ['Provide a spoken answer to the question so it can be evaluated.'],
          topicsCovered: [],
          success: true,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const systemPrompt = `You are a strict but fair technical interviewer grading a candidate's spoken answer. You reply with JSON only.

Grading rules (follow exactly):
- Score ONLY what the candidate actually said. Never invent content or assume intent.
- If the answer is empty, off-topic, filler ("um", "I don't know", "next"), or unrelated to the question, score 0-1 and say so plainly.
- Partially correct but shallow answers score 3-5. Solid answers score 6-8. Only genuinely complete, accurate, well-reasoned answers score 9-10.
- The answer is a speech transcript, so ignore punctuation, filler words and small transcription errors; judge the substance.
- Never give a score at random or as encouragement. Scores must be justified by the quoted answer.

Spoken-conversation rules for the "feedback" field:
- Write the feedback in the SAME language and script the candidate answered in (English, Hindi, Telugu, Tamil, Hinglish, etc.). Mirror their mix if they mix.
- It will be read aloud by a voice interviewer, so keep it to 1-2 short, natural spoken sentences. No markdown, no lists, no emoji.
- Sound like a warm Indian interviewer talking to the candidate directly ("you"), then stop — the next question is added separately.`;

    const userPrompt = `You are analyzing a candidate's response for a ${role} position.

Question asked: "${question}"

Candidate's answer: "${answer}"

${expectedTopics?.length ? `Expected topics to cover: ${expectedTopics.join(', ')}` : ''}

${feedbackStyle}

Provide a JSON response with:
{
  "score": <number 0-10 overall, per the grading rules>,
  "technicalScore": <number 0-10 technical accuracy and depth>,
  "communicationScore": <number 0-10 clarity and structure of the spoken answer>,
  "problemSolvingScore": <number 0-10 reasoning and approach>,
  "confidenceScore": <number 0-10 decisiveness, based only on what was said>,
  "feedback": "<brief spoken feedback to give the candidate>",
  "idealAnswer": "<a model answer to this question in clear English, 3-6 sentences, covering the key points a strong candidate would mention>",
  "strengths": ["<strength1>", "<strength2>"],
  "improvements": ["<improvement1>", "<improvement2>"],
  "topicsCovered": ["<topic1>", "<topic2>"],
  "followUpQuestion": "<optional follow-up question if needed>"
}

If the candidate did not really answer, return zeros with empty strengths.
Only respond with the JSON object, no other text.`;

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
            temperature: 0.2,
            responseMimeType: 'application/json',
          },
        }),
      });

    console.log('Sending interview response analysis request to Gemini, model:', primaryModel);
    let response = await requestGemini(primaryModel);
    let usedModel = primaryModel;
    if (response.status === 503) {
      console.warn('Gemini interview analysis model is overloaded; trying fallback:', fallbackModel);
      await response.text();
      usedModel = fallbackModel;
      response = await requestGemini(fallbackModel);
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Gemini API Error (${usedModel}):`, response.status, errorText.slice(0, 1000));
      if (response.status === 429) throw new Error('Gemini rate limit exceeded. Please try again later.');
      let detail = '';
      try {
        detail = JSON.parse(errorText)?.error?.message || '';
      } catch {
        detail = errorText.slice(0, 300);
      }
      if (response.status === 503) {
        throw new Error('Gemini is temporarily overloaded. Please try again in a moment.');
      }
      throw new Error(`Gemini API error (${response.status})${detail ? `: ${detail}` : ''}`);
    }

    const data = await response.json();
    const content = data.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part.text || '')
      .join('')
      .trim();

    if (!content) {
      console.error('No content in Gemini response');
      throw new Error('Gemini returned no response analysis. Please try again.');
    }

    console.log('Gemini response received, parsing analysis...');

    let analysis;
    try {
      const cleanContent = content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      analysis = JSON.parse(cleanContent);
    } catch {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        console.error('Failed to parse Gemini analysis response:', content.slice(0, 1000));
        throw new Error('Failed to parse response analysis from Gemini.');
      }
    }

    if (!analysis || typeof analysis !== 'object' || typeof analysis.score !== 'number') {
      throw new Error('Gemini returned response analysis in an unexpected format.');
    }

    console.log('Successfully analyzed response, score:', analysis.score);

    return new Response(
      JSON.stringify({ ...analysis, success: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    console.error('Analysis Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
