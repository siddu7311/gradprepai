import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function extractJsonArray(text: string): string | null {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '[') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === ']' && depth > 0) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return null;
}

function repairCommonJsonFormatting(text: string): string {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }

    if (character === ',' || character === '{') {
      let next = index + 1;
      while (/\s/.test(text[next] || '')) next += 1;

      if (character === ',') {
        if (text[next] === '}' || text[next] === ']') {
          index = next - 1;
          continue;
        }
        output += character;
        output += text.slice(index + 1, next);
      } else {
        output += character;
      }

      const keyMatch = text.slice(next).match(/^([A-Za-z_$][\w$]*)\s*:/);
      if (keyMatch) {
        output += `"${keyMatch[1]}":`;
        index = next + keyMatch[0].length - 1;
      }
      continue;
    }

    output += character;
  }

  return output;
}

function parseGeneratedQuestions(content: string): unknown[] | null {
  const unwrapped = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const extracted = extractJsonArray(unwrapped);
  const candidates = [...new Set([unwrapped, extracted].filter((value): value is string => !!value))];

  for (const candidate of candidates) {
    for (const input of [candidate, repairCommonJsonFormatting(candidate)]) {
      try {
        const parsed: unknown = JSON.parse(input);
        if (Array.isArray(parsed)) return parsed;
        if (typeof parsed === 'object' && parsed !== null && 'questions' in parsed) {
          const questions = (parsed as { questions?: unknown }).questions;
          if (Array.isArray(questions)) return questions;
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

function normalizeQuestion(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  const question = value as Record<string, unknown>;
  const rawQuestionText = question.question_text ?? question.questionText ?? question.question ?? question.prompt;
  const questionText = typeof rawQuestionText === 'string' ? rawQuestionText.trim() : '';
  if (!questionText) return null;

  let rawOptions = question.options ?? question.answer_options ?? question.answerOptions ??
    question.answer_choices ?? question.answerChoices ?? question.choices;
  if (typeof rawOptions === 'string') {
    try {
      rawOptions = JSON.parse(rawOptions);
    } catch {
      return null;
    }
  }
  if (typeof rawOptions === 'object' && rawOptions !== null && !Array.isArray(rawOptions)) {
    const optionObject = rawOptions as Record<string, unknown>;
    if (Array.isArray(optionObject.options)) rawOptions = optionObject.options;
    else if (Array.isArray(optionObject.choices)) rawOptions = optionObject.choices;
  }
  const optionEntries: unknown[] = Array.isArray(rawOptions)
    ? rawOptions
    : typeof rawOptions === 'object' && rawOptions !== null
      ? Object.entries(rawOptions).map(([id, value]) =>
        typeof value === 'object' && value !== null
          ? { ...(value as Record<string, unknown>), id: (value as Record<string, unknown>).id ?? id }
          : { id, text: value },
      )
      : [];

  const seenIds = new Set<string>();
  const correctOptionIds = new Set<string>();
  const options = optionEntries.flatMap((entry, index) => {
    if (typeof entry === 'string' && entry.trim()) {
      const id = String.fromCharCode(65 + index);
      seenIds.add(id);
      return [{ id, text: entry.trim() }];
    }
    if (typeof entry !== 'object' || entry === null) return [];
    const option = entry as Record<string, unknown>;
    const rawText = option.text ?? option.option_text ?? option.optionText ?? option.option ??
      option.value ?? option.label;
    if ((typeof rawText !== 'string' && typeof rawText !== 'number') || !String(rawText).trim()) return [];
    const rawId = option.id ?? option.key ?? option.option_id ?? option.optionId;
    let id = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : String.fromCharCode(65 + index);
    if (seenIds.has(id)) {
      id = String.fromCharCode(65 + index);
      let suffix = 1;
      while (seenIds.has(id)) {
        id = `OPTION-${index + 1}-${suffix}`;
        suffix += 1;
      }
    }
    seenIds.add(id);
    if (
      option.is_correct === true || option.is_correct === 'true' ||
      option.isCorrect === true || option.isCorrect === 'true' ||
      option.correct === true || option.correct === 'true'
    ) {
      correctOptionIds.add(id);
    }
    return [{ id, text: String(rawText).trim() }];
  });
  if (options.length < 2) return null;
  if (
    new Set(options.map(option => option.text.toLowerCase())).size !== options.length ||
    options.some(option => /^(?:option\s*)?[a-d]$/i.test(option.text))
  ) return null;

  if (Array.isArray(question.correct_answer)) return null;
  const rawAnswerValue = question.correct_answer ?? question.correctAnswer ?? question.correct_option ??
    question.correctOption ?? question.correct_option_id ?? question.correctOptionId ??
    question.answer_key ?? question.answerKey ?? question.answer;
  const answerObject = typeof rawAnswerValue === 'object' && rawAnswerValue !== null
    ? rawAnswerValue as Record<string, unknown>
    : null;
  const rawAnswer = String(
    answerObject?.id ?? answerObject?.key ?? answerObject?.label ?? answerObject?.text ??
    answerObject?.value ?? rawAnswerValue ?? '',
  ).trim();
  const directOption = options.find(option =>
    option.id.toLowerCase() === rawAnswer.toLowerCase() ||
    option.text.toLowerCase() === rawAnswer.toLowerCase(),
  );
  const answerLabel = rawAnswer.match(/^(?:option\s*)?([a-z])(?:\s*[.)-]|\s+)/i)?.[1];
  const labeledOption = answerLabel
    ? options.find(option => option.id.toLowerCase() === answerLabel.toLowerCase())
    : undefined;
  const markedCorrectOption = correctOptionIds.size === 1 ? [...correctOptionIds][0] : undefined;
  const answer = directOption?.id ?? labeledOption?.id ?? markedCorrectOption;
  if (!answer) return null;

  return {
    question_text: questionText,
    question_type: 'mcq',
    options,
    correct_answer: answer,
    explanation: typeof question.explanation === 'string' ? question.explanation : '',
    difficulty: typeof question.difficulty === 'string' ? question.difficulty : 'medium',
    marks: typeof question.marks === 'number' && question.marks > 0 ? question.marks : 1,
    negative_marks: typeof question.negative_marks === 'number' && question.negative_marks >= 0
      ? question.negative_marks
      : 0,
    tags: Array.isArray(question.tags) ? question.tags.filter((tag): tag is string => typeof tag === 'string') : [],
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const {
      topic_name,
      category_name,
      difficulty = 'medium',
      count = 5,
      question_type = 'mcq',
      existing_question_texts = [],
    } = await req.json() as {
      topic_name: string;
      category_name: string;
      difficulty?: string;
      count?: number;
      question_type?: string;
      existing_question_texts?: string[];
    };

    if (!topic_name) {
      return new Response(JSON.stringify({ error: 'topic_name is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')?.trim();
    if (!GEMINI_API_KEY) {
      return new Response(JSON.stringify({ error: 'GEMINI_API_KEY is not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const systemPrompt = `You are a competitive exam question generator for aptitude tests used in campus placements and competitive exams (similar to TCS, Infosys, Wipro, CAT, GATE style questions).
Generate questions that are:
- Unambiguous with exactly ONE clearly correct answer (for MCQ)
- Validated: the answer must be mathematically/logically provable
- Appropriate for the given difficulty
- Not repeating previously given questions
- Every option must be a real, complete answer choice, never a label or placeholder
Reply with valid JSON only. No markdown.`;

    const difficultyGuide: Record<string, string> = {
      easy: 'straightforward, solvable in under 30 seconds, basic formula application',
      medium: 'requires 2-3 steps, moderate reasoning, typical placement-level',
      hard: 'multi-step, tricky conditions, above-average reasoning required',
    };

    const avoidList = existing_question_texts.slice(-20).join('\n- ');

    const userPrompt = `Generate ${count} ${question_type.toUpperCase()} aptitude questions for:
- Topic: ${topic_name}
- Category: ${category_name}
- Difficulty: ${difficulty} (${difficultyGuide[difficulty] || difficultyGuide.medium})
${avoidList ? `\nDo NOT repeat or paraphrase these existing questions:\n- ${avoidList}` : ''}

Return a JSON array using exactly these field names and data types:
[
  {
    "question_text": "Full question text",
    "question_type": "${question_type}",
    "options": [{"id": "A", "text": "A realistic answer value or phrase"}, {"id": "B", "text": "A different plausible answer"}, {"id": "C", "text": "The correct value or phrase"}, {"id": "D", "text": "Another plausible distractor"}],
    "correct_answer": "A",
    "explanation": "Step-by-step solution explaining why the answer is correct",
    "difficulty": "${difficulty}",
    "marks": 1,
    "tags": ["tag1"]
  }
]

Rules:
- For MCQ: exactly 4 options (A, B, C, D), one correct
- Option IDs are only labels. Option text must contain the actual answer, such as "12.5%" or "Rs. 1,200", never "A", "Option A", "B", "Option B", or similar placeholders.
- All four option texts must be distinct and relevant to the question.
- Make distractors plausible but incorrect; never copy the option IDs into their text.
- Before returning, verify that every option contains a real answer and that correct_answer refers to the ID of the genuinely correct option.
- The explanation MUST agree with the correct_answer — verify this before responding
- For math questions, show working in the explanation
- For verbal/logical, explain the reasoning clearly
- Keep the exact field names: question_text, question_type, options, correct_answer, explanation, difficulty, marks, tags
- options must be an array of objects with string id and string text fields; correct_answer must be one option id
- Do not generate trick questions that are misleading without a clear rule
- Only respond with the JSON array`;

    const callGemini = (model: string) =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.7, responseMimeType: 'application/json' },
        }),
      });

    const models = ['gemini-3.5-flash-lite', 'gemini-2.5-flash'];
    let response: Response | undefined;
    let modelUsed = '';
    let providerError = '';

    for (const [index, model] of models.entries()) {
      response = await callGemini(model);
      modelUsed = model;
      if (response.ok) break;

      providerError = await response.text();
      console.error('Gemini aptitude error:', {
        model,
        status: response.status,
        details: providerError.slice(0, 500),
      });

      if (index < models.length - 1 && (response.status === 404 || response.status === 503)) {
        continue;
      }
      break;
    }

    if (!response || !response.ok) {
      const detail = providerError ? `: ${providerError.slice(0, 300)}` : '';
      throw new Error(`Gemini API error (${response?.status ?? 'unknown'}) for model ${modelUsed}${detail}`);
    }

    const readQuestions = async (
      geminiResponse: Response,
    ): Promise<{ questions: Record<string, unknown>[]; parsed: boolean }> => {
      try {
        const payload = await geminiResponse.json();
        const generatedContent = payload.candidates?.[0]?.content?.parts
          ?.map((part: { text?: string }) => part.text || '')
          .join('')
          .trim();
        const questions = generatedContent ? parseGeneratedQuestions(generatedContent) : null;
        if (!questions) {
          console.error('Gemini returned no parseable question array:', {
            candidateCount: payload.candidates?.length ?? 0,
            finishReason: payload.candidates?.[0]?.finishReason ?? 'unknown',
          });
          return { questions: [], parsed: false };
        }

        const usableQuestions = questions
          .map(normalizeQuestion)
          .filter((question): question is Record<string, unknown> => question !== null);
        if (usableQuestions.length !== questions.length) {
          console.error('Gemini returned questions that did not pass validation:', {
            model: modelUsed,
            returnedCount: questions.length,
            usableCount: usableQuestions.length,
            firstQuestionFields: typeof questions[0] === 'object' && questions[0] !== null
              ? Object.keys(questions[0] as Record<string, unknown>)
              : [],
          });
        }
        return { questions: usableQuestions, parsed: true };
      } catch (error) {
        console.error('Could not parse Gemini response payload:', error);
        return { questions: [], parsed: false };
      }
    };

    let result = await readQuestions(response);
    if (result.questions.length === 0 && modelUsed !== models[models.length - 1]) {
      const retryModel = models[models.length - 1];
      const retryResponse = await callGemini(retryModel);
      if (retryResponse.ok) {
        modelUsed = retryModel;
        result = await readQuestions(retryResponse);
      } else {
        const retryError = await retryResponse.text();
        console.error('Gemini aptitude retry failed:', {
          model: retryModel,
          status: retryResponse.status,
          details: retryError.slice(0, 500),
        });
      }
    }

    if (result.questions.length === 0) {
      throw new Error(result.parsed
        ? 'Gemini returned questions without valid text, answer options, and correct answers. Please retry.'
        : 'Gemini returned malformed question JSON. Please retry question generation.');
    }

    return new Response(JSON.stringify({ success: true, questions: result.questions }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('aptitude-generate-questions error:', err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
