export interface PracticeQuestion {
  id: string;
  question_text: string;
  question_type: string;
  options: Array<{ id: string; text: string }> | null;
  correct_answer: string | string[];
  marks: number;
  negative_marks: number;
}

export interface PracticeOption {
  id: string;
  text: string;
}

export interface PracticeResponse {
  answer: string | string[] | null;
  isCorrect: boolean | null;
}

function hasPlaceholderOptionText(option: PracticeOption): boolean {
  return /^(?:option\s*)?[a-d]$/i.test(option.text.trim());
}

export function includeDraftAnswers<T extends PracticeQuestion>(
  questions: T[],
  responses: Record<string, PracticeResponse>,
  drafts: Record<string, string | null>,
): Record<string, PracticeResponse> {
  const finalResponses = { ...responses };
  for (const question of questions) {
    const answer = drafts[question.id];
    if (finalResponses[question.id] || !answer) continue;
    finalResponses[question.id] = {
      answer,
      isCorrect: isPracticeAnswerCorrect(question, answer),
    };
  }
  return finalResponses;
}

function answersMatch(
  answer: string | string[],
  correctAnswer: string | string[],
): boolean {
  if (Array.isArray(answer) && Array.isArray(correctAnswer)) {
    return answer.length === correctAnswer.length &&
      correctAnswer.every(value => answer.includes(value));
  }
  if (Array.isArray(answer) || Array.isArray(correctAnswer)) return false;
  return answer.trim().toLowerCase() === correctAnswer.trim().toLowerCase();
}

function answerOptionId(answer: unknown, options: PracticeOption[] | null): string | null {
  const value = typeof answer === 'string' || typeof answer === 'number'
    ? String(answer).trim().replace(/^["']|["']$/g, '')
    : '';
  if (!value || !options) return null;

  const exactOption = options.find(option =>
    option.id.trim().toLowerCase() === value.toLowerCase() ||
    option.text.trim().toLowerCase() === value.toLowerCase(),
  );
  if (exactOption) return exactOption.id;

  const label = value.match(
    /^(?:(?:the\s+)?correct\s+answer\s*(?:is|:)\s*)?(?:option\s*)?([a-z])(?:\s*[.):-]|\s*$)/i,
  )?.[1];
  return label
    ? options.find(option => option.id.trim().toLowerCase() === label.toLowerCase())?.id ?? null
    : null;
}

export function isPracticeAnswerCorrect(
  question: Pick<PracticeQuestion, 'options' | 'correct_answer'>,
  answer: string | string[] | null,
): boolean {
  if (answer === null) return false;
  if (Array.isArray(answer)) {
    if (!Array.isArray(question.correct_answer)) return false;
    const selected = answer.map(value => answerOptionId(value, question.options) ?? value.trim().toLowerCase());
    const correct = question.correct_answer.map(value =>
      answerOptionId(value, question.options) ?? value.trim().toLowerCase(),
    );
    return selected.length === correct.length && correct.every(value => selected.includes(value));
  }

  const correctAnswer = Array.isArray(question.correct_answer)
    ? null
    : answerOptionId(question.correct_answer, question.options);
  const selectedAnswer = answerOptionId(answer, question.options);
  if (correctAnswer && selectedAnswer) return correctAnswer === selectedAnswer;

  return !Array.isArray(question.correct_answer) &&
    answersMatch(answer, question.correct_answer);
}

export function describeAptitudeCategoryError(error: unknown): string {
  const details = typeof error === 'object' && error !== null
    ? error as { code?: unknown; message?: unknown }
    : {};
  const code = typeof details.code === 'string' ? details.code : '';
  const message = typeof details.message === 'string' ? details.message : '';

  if (
    code === 'PGRST205' ||
    code === '42P01' ||
    /aptitude_categories.*(not found|does not exist)|relation .*aptitude_categories.*does not exist/i.test(message)
  ) {
    return 'The aptitude category table is missing from Supabase. Apply the project migration 20260810000000_feature_expansion.sql, then retry.';
  }
  if (code === '42501') {
    return 'Supabase denied access to aptitude categories. Check that the signed-in role has SELECT access and the apt_cat_read RLS policy.';
  }
  if (/failed to fetch|networkerror|fetch failed/i.test(message)) {
    return 'Could not reach Supabase. Check the project URL, network connection, and Supabase availability, then retry.';
  }

  return message
    ? `Could not load aptitude categories${code ? ` (${code})` : ''}: ${message}`
    : 'Could not load aptitude categories. Check the browser console and Supabase project configuration, then retry.';
}

export async function describeAptitudeGenerationError(error: unknown): Promise<string> {
  const details = typeof error === 'object' && error !== null
    ? error as { message?: unknown; context?: unknown }
    : {};
  const message = typeof details.message === 'string' ? details.message : '';
  const response = details.context instanceof Response ? details.context : null;

  if (response) {
    if (response.status === 404) {
      return 'No published questions were found, and the aptitude-generate-questions Edge Function is not deployed. Deploy it in Supabase, then retry.';
    }

    try {
      const body: unknown = await response.clone().json();
      if (typeof body === 'object' && body !== null && 'error' in body) {
        const functionMessage = (body as { error?: unknown }).error;
        if (typeof functionMessage === 'string' && /GEMINI_API_KEY is not configured/i.test(functionMessage)) {
          return 'No published questions were found, and question generation is not configured. Add GEMINI_API_KEY to Supabase Edge Function secrets, deploy aptitude-generate-questions, then retry.';
        }
        if (typeof functionMessage === 'string' && functionMessage.trim()) {
          return `Question generation failed: ${functionMessage}`;
        }
      }
    } catch {
      // Fall back to the response status if the function did not return JSON.
    }

    return `No published questions were found, and the aptitude question generator returned HTTP ${response.status}. Check the Edge Function logs in Supabase, then retry.`;
  }

  return message
    ? `No published questions were found, and the aptitude question generator could not be reached: ${message}`
    : 'No published questions were found, and question generation could not be completed. Check the Edge Function deployment and logs, then retry.';
}

export function getPracticeCategoryIds(
  categories: Array<{ id: string }>,
  selectedCategoryId: string,
  mixedPractice: boolean,
): string[] {
  if (mixedPractice) return categories.map(category => category.id);
  return categories.some(category => category.id === selectedCategoryId)
    ? [selectedCategoryId]
    : [];
}

export function normalizeGeneratedOptions(
  rawOptions: unknown,
  rawCorrectAnswer: unknown,
): { options: PracticeOption[] | null; correctAnswer: string | string[] } {
  let candidateOptions = rawOptions;
  if (typeof candidateOptions === 'string') {
    try {
      candidateOptions = JSON.parse(candidateOptions);
    } catch {
      candidateOptions = [];
    }
  }

  const entries: unknown[] = Array.isArray(candidateOptions)
    ? candidateOptions
    : typeof candidateOptions === 'object' && candidateOptions !== null
      ? Object.entries(candidateOptions).map(([id, value]) => ({ id, text: value }))
      : [];

  const options = entries.flatMap((entry, index): PracticeOption[] => {
    if (typeof entry === 'string') {
      const text = entry.trim();
      return text ? [{ id: String.fromCharCode(65 + index), text }] : [];
    }
    if (typeof entry !== 'object' || entry === null) return [];

    const option = entry as Record<string, unknown>;
    const textValue = option.text ?? option.label ?? option.value ?? option.option_text;
    if ((typeof textValue !== 'string' && typeof textValue !== 'number') || !String(textValue).trim()) return [];

    const candidateId = option.id ?? option.key;
    const id = typeof candidateId === 'string' && candidateId.trim()
      ? candidateId.trim()
      : String.fromCharCode(65 + index);
    const text = String(textValue).trim().replace(/^[a-d]\s*[.)-]\s*/i, '');
    return text ? [{ id, text }] : [];
  });

  const seenIds = new Set<string>();
  const normalized = options.map((option, index) => {
    let id = option.id;
    if (seenIds.has(id)) {
      id = String.fromCharCode(65 + index);
      let suffix = 1;
      while (seenIds.has(id)) {
        id = `OPTION-${index + 1}-${suffix}`;
        suffix += 1;
      }
    }
    seenIds.add(id);
    return { ...option, id };
  });

  const answerValues = Array.isArray(rawCorrectAnswer) ? rawCorrectAnswer : [rawCorrectAnswer];
  const mappedAnswers = answerValues.map(answer =>
    answerOptionId(answer, normalized) ?? String(answer ?? '').trim(),
  );

  return {
    options: normalized.length ? normalized : null,
    correctAnswer: Array.isArray(rawCorrectAnswer) ? mappedAnswers : mappedAnswers[0],
  };
}

export function normalizeQuestionForPractice<T extends {
  options: unknown;
  correct_answer: unknown;
}>(question: T): T & {
  options: PracticeOption[] | null;
  correct_answer: string | string[];
} {
  const normalized = normalizeGeneratedOptions(question.options, question.correct_answer);
  return { ...question, options: normalized.options, correct_answer: normalized.correctAnswer };
}

export function filterUsablePracticeQuestions<
  T extends Omit<PracticeQuestion, 'options' | 'correct_answer'> & {
    options: unknown;
    correct_answer: unknown;
  },
>(
  questions: T[],
): Array<T & { options: PracticeOption[] | null; correct_answer: string | string[] }> {
  return questions
    .map(normalizeQuestionForPractice)
    .filter(question => validatePracticeQuestions([question]) === null);
}

export function validatePracticeQuestions(questions: PracticeQuestion[]): string | null {
  if (questions.length === 0) return 'No questions are available for this selection.';

  const ids = new Set<string>();
  for (const question of questions) {
    if (!question.id || ids.has(question.id)) return 'The question bank returned invalid or duplicate questions.';
    ids.add(question.id);

    if (!question.question_text?.trim()) return 'The question bank returned a question with no text.';
    if (!['mcq', 'passage_mcq'].includes(question.question_type)) {
      return 'The question bank returned a question type that this practice mode cannot display.';
    }
    if (!question.options || question.options.length < 2 ||
      question.options.some(option => !option.id || !option.text?.trim()) ||
      new Set(question.options.map(option => option.id.trim().toLowerCase())).size !== question.options.length ||
      new Set(question.options.map(option => option.text.trim().toLowerCase())).size !== question.options.length ||
      question.options.some(hasPlaceholderOptionText)) {
      return 'The question bank returned a question with invalid answer options.';
    }
    if (
      !question.correct_answer ||
      (Array.isArray(question.correct_answer)
        ? question.correct_answer.length === 0 ||
          question.correct_answer.some(answer => !answerOptionId(answer, question.options))
        : !answerOptionId(question.correct_answer, question.options))
    ) {
      return 'The question bank returned a question with an invalid correct answer.';
    }
  }

  return null;
}

export function calculatePracticeResults(
  questions: PracticeQuestion[],
  responses: Record<string, PracticeResponse>,
) {
  let correct = 0;
  let wrong = 0;
  let answered = 0;
  let score = 0;

  for (const question of questions) {
    const response = responses[question.id];
    if (!response || response.answer === null) continue;

    answered += 1;
    if (isPracticeAnswerCorrect(question, response.answer)) {
      correct += 1;
      score += question.marks;
    } else {
      wrong += 1;
      score -= question.negative_marks;
    }
  }

  return {
    correct,
    wrong,
    skipped: questions.length - answered,
    score: Math.max(0, Math.round(score)),
    accuracy: answered > 0 ? Math.round((correct / answered) * 100) : 0,
  };
}
