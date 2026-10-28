/**
 * Aptitude Round — unit tests
 *
 * These tests exercise pure logic without a DOM, Supabase client,
 * or any network calls, in line with the project rule that says
 * "use Bun's built-in test runner for isolated tests that don't
 * require a DOM or external service."
 */
import { describe, expect, test } from 'bun:test';
import {
  calculatePracticeResults,
  describeAptitudeCategoryError,
  describeAptitudeGenerationError,
  filterUsablePracticeQuestions,
  getPracticeCategoryIds,
  includeDraftAnswers,
  isPracticeAnswerCorrect,
  normalizeGeneratedOptions,
  normalizeQuestionForPractice,
  validatePracticeQuestions,
  type PracticeQuestion,
} from '../src/lib/aptitudePractice';
import { parseGeneratedQuestions } from '../supabase/functions/aptitude-generate-questions/aptitudeQuestionParsing';

const validQuestion: PracticeQuestion = {
  id: 'question-1',
  question_text: 'What is 2 + 2?',
  question_type: 'mcq',
  options: [
    { id: 'A', text: '3' },
    { id: 'B', text: '4' },
  ],
  correct_answer: 'B',
  marks: 1,
  negative_marks: 0.25,
};

describe('aptitude practice setup', () => {
  const categories = [{ id: 'quant-id' }, { id: 'verbal-id' }];

  test('category selection resolves to the real database category id', () => {
    expect(getPracticeCategoryIds(categories, 'verbal-id', false)).toEqual(['verbal-id']);
  });

  test('mixed practice resolves all available database category ids', () => {
    expect(getPracticeCategoryIds(categories, '', true)).toEqual(['quant-id', 'verbal-id']);
  });

  test('missing or stale category selection resolves to no ids', () => {
    expect(getPracticeCategoryIds(categories, '', false)).toEqual([]);
    expect(getPracticeCategoryIds(categories, 'stale-id', false)).toEqual([]);
  });

  test('validates a question before opening a session', () => {
    expect(validatePracticeQuestions([validQuestion])).toBeNull();
  });

  test('normalizes generated options and maps answer text to the option id', () => {
    const normalized = normalizeGeneratedOptions(
      ['first answer', 'second answer', 'third answer', 'fourth answer'],
      'second answer',
    );

    expect(normalized).toEqual({
      options: [
        { id: 'A', text: 'first answer' },
        { id: 'B', text: 'second answer' },
        { id: 'C', text: 'third answer' },
        { id: 'D', text: 'fourth answer' },
      ],
      correctAnswer: 'B',
    });
    expect(validatePracticeQuestions([{
      ...validQuestion,
      options: normalized.options,
      correct_answer: normalized.correctAnswer,
    }])).toBeNull();
  });

  test('fills missing option ids and accepts keyed options', () => {
    expect(normalizeGeneratedOptions([
      { text: 'first' },
      { id: 'B', label: 'second' },
    ], 'B')).toEqual({
      options: [{ id: 'A', text: 'first' }, { id: 'B', text: 'second' }],
      correctAnswer: 'B',
    });
    expect(normalizeGeneratedOptions({ A: 'first', B: 'second' }, 'second').correctAnswer).toBe('B');
  });

  test('normalizes JSON-encoded bank options and option-label answers', () => {
    const question = normalizeQuestionForPractice({
      ...validQuestion,
      options: '[{"text":"three"},{"text":"four"}]',
      correct_answer: 'Option B. four',
    });

    expect(question.options).toEqual([{ id: 'A', text: 'three' }, { id: 'B', text: 'four' }]);
    expect(question.correct_answer).toBe('B');
    expect(validatePracticeQuestions([question])).toBeNull();
  });

  test('scores letter answers expressed as Option B or Correct answer: B', () => {
    const question = {
      options: validQuestion.options,
      correct_answer: 'Option B',
    };
    expect(isPracticeAnswerCorrect(question, 'B')).toBe(true);
    expect(isPracticeAnswerCorrect({ ...question, correct_answer: 'Correct answer: B' }, 'B')).toBe(true);
    expect(isPracticeAnswerCorrect(question, 'A')).toBe(false);
    expect(normalizeQuestionForPractice({
      ...validQuestion,
      correct_answer: 'Option B',
    }).correct_answer).toBe('B');
  });

  test('rejects empty question results and malformed options', () => {
    expect(validatePracticeQuestions([])).toMatch(/No questions/);
    expect(validatePracticeQuestions([{ ...validQuestion, options: null }])).toMatch(/invalid answer options/);
    expect(validatePracticeQuestions([{ ...validQuestion, correct_answer: 'C' }])).toMatch(/invalid correct answer/);
  });

  test('rejects generated placeholder and duplicate option text', () => {
    expect(validatePracticeQuestions([{
      ...validQuestion,
      options: [
        { id: 'A', text: 'A' },
        { id: 'B', text: 'B' },
      ],
    }])).toMatch(/invalid answer options/);
    expect(validatePracticeQuestions([{
      ...validQuestion,
      options: [
        { id: 'A', text: '100' },
        { id: 'B', text: '100' },
      ],
    }])).toMatch(/invalid answer options/);
  });

  test('keeps valid quantitative bank questions and filters malformed records', () => {
    const results = filterUsablePracticeQuestions([
      validQuestion,
      {
        ...validQuestion,
        id: 'bad-options',
        options: [
          { id: 'A', text: 'A' },
          { id: 'B', text: 'B' },
        ],
      },
      {
        ...validQuestion,
        id: 'json-options',
        options: '[{"id":"A","text":"Rs. 100"},{"id":"B","text":"Rs. 200"}]',
      },
    ]);

    expect(results.map(question => question.id)).toEqual(['question-1', 'json-options']);
    expect(results[1].options).toEqual([
      { id: 'A', text: 'Rs. 100' },
      { id: 'B', text: 'Rs. 200' },
    ]);
  });

  test('explains missing aptitude table and access-policy errors', () => {
    expect(describeAptitudeCategoryError({
      code: 'PGRST205',
      message: "Could not find the table 'public.aptitude_categories' in the schema cache",
    })).toContain('20260810000000_feature_expansion.sql');
    expect(describeAptitudeCategoryError({
      code: '42501',
      message: 'permission denied',
    })).toContain('apt_cat_read');
  });

  test('explains question-generator configuration and deployment errors', async () => {
    const missingKey = await describeAptitudeGenerationError({
      message: 'Edge Function returned a non-2xx status code',
      context: new Response(JSON.stringify({ error: 'GEMINI_API_KEY is not configured' }), { status: 500 }),
    });
    expect(missingKey).toContain('GEMINI_API_KEY');

    const missingFunction = await describeAptitudeGenerationError({
      message: 'Edge Function returned a non-2xx status code',
      context: new Response('Not Found', { status: 404 }),
    });
    expect(missingFunction).toContain('not deployed');
  });
});

describe('Gemini question JSON parsing', () => {
  test('parses valid arrays and markdown-wrapped JSON', () => {
    expect(parseGeneratedQuestions('[{"question_text":"Question"}]')).toEqual([
      { question_text: 'Question' },
    ]);
    expect(parseGeneratedQuestions('```json\n[{"question_text":"Question"}]\n```')).toEqual([
      { question_text: 'Question' },
    ]);
  });

  test('repairs unquoted object keys and trailing commas', () => {
    expect(parseGeneratedQuestions(`[
      {
        question_text: "Question",
        options: [{id: "A", text: "Actual answer"}, {id: "B", text: "Other answer"},],
      },
    ]`)).toEqual([{
      question_text: 'Question',
      options: [
        { id: 'A', text: 'Actual answer' },
        { id: 'B', text: 'Other answer' },
      ],
    }]);
  });

  test('does not rewrite object-like text inside quoted strings', () => {
    expect(parseGeneratedQuestions('[{"question_text":"Use {answer: value}"}]')).toEqual([
      { question_text: 'Use {answer: value}' },
    ]);
  });

  test('returns null for unrecoverable JSON', () => {
    expect(parseGeneratedQuestions('[{"question_text": ]')).toBeNull();
  });
});

describe('aptitude practice results', () => {
  test('counts correct, incorrect, skipped, accuracy, and marks', () => {
    const questions = [
      validQuestion,
      { ...validQuestion, id: 'question-2', marks: 2, negative_marks: 0 },
      { ...validQuestion, id: 'question-3', marks: 1, negative_marks: 0.25 },
    ];
    const result = calculatePracticeResults(questions, {
      'question-1': { answer: 'B', isCorrect: true },
      'question-2': { answer: 'A', isCorrect: false },
      'question-3': { answer: null, isCorrect: null },
    });

    expect(result).toEqual({
      correct: 1,
      wrong: 1,
      skipped: 1,
      score: 1,
      accuracy: 50,
    });
  });

  test('evaluates correctness from the submitted answer, not a stale result flag', () => {
    const result = calculatePracticeResults([validQuestion], {
      'question-1': { answer: 'B', isCorrect: false },
    });

    expect(result.correct).toBe(1);
    expect(result.wrong).toBe(0);
    expect(result.accuracy).toBe(100);
  });

  test('includes selected draft answers at finish and preserves explicit skips', () => {
    const questions = [
      validQuestion,
      { ...validQuestion, id: 'question-2' },
      { ...validQuestion, id: 'question-3' },
    ];
    const finalResponses = includeDraftAnswers(
      questions,
      { 'question-2': { answer: null, isCorrect: null } },
      { 'question-1': 'B', 'question-3': 'A' },
    );

    expect(finalResponses).toEqual({
      'question-1': { answer: 'B', isCorrect: true },
      'question-2': { answer: null, isCorrect: null },
      'question-3': { answer: 'A', isCorrect: false },
    });
    expect(calculatePracticeResults(questions, finalResponses)).toMatchObject({
      correct: 1,
      wrong: 1,
      skipped: 1,
      accuracy: 50,
    });
  });

  test('finishing with five correct selected answers reports 5/5 and 100 percent', () => {
    const questions = Array.from({ length: 5 }, (_, index) => ({
      ...validQuestion,
      id: `question-${index + 1}`,
    }));
    const drafts = Object.fromEntries(questions.map(question => [question.id, 'B']));
    const finalResponses = includeDraftAnswers(questions, {}, drafts);

    expect(calculatePracticeResults(questions, finalResponses)).toEqual({
      correct: 5,
      wrong: 0,
      skipped: 0,
      score: 5,
      accuracy: 100,
    });
  });
});

// ── helpers replicated from useAptitude (pure logic only) ───────────────────

function isAnswerCorrect(
  userAnswer: string | string[] | null,
  correctAnswer: string | string[],
): boolean {
  if (userAnswer === null) return false;
  if (Array.isArray(correctAnswer) && Array.isArray(userAnswer)) {
    return (
      correctAnswer.length === userAnswer.length &&
      correctAnswer.every((a) => userAnswer.includes(a))
    );
  }
  return (
    String(userAnswer).trim().toLowerCase() ===
    String(correctAnswer).trim().toLowerCase()
  );
}

function computeMarks(
  isCorrect: boolean,
  answered: boolean,
  marks: number,
  negativeMarks: number,
): number {
  if (isCorrect) return marks;
  if (answered) return -negativeMarks;
  return 0;
}

function computeAccuracy(correct: number, answered: number): number {
  return answered > 0 ? Math.round((correct / answered) * 100) : 0;
}

// ── isAnswerCorrect ──────────────────────────────────────────────────────────

describe('isAnswerCorrect — MCQ single answer', () => {
  test('exact match returns true', () => {
    expect(isAnswerCorrect('A', 'A')).toBe(true);
  });

  test('case-insensitive match', () => {
    expect(isAnswerCorrect('a', 'A')).toBe(true);
    expect(isAnswerCorrect('A', 'a')).toBe(true);
  });

  test('wrong option returns false', () => {
    expect(isAnswerCorrect('B', 'A')).toBe(false);
  });

  test('null answer returns false', () => {
    expect(isAnswerCorrect(null, 'A')).toBe(false);
  });

  test('numeric answer string match', () => {
    expect(isAnswerCorrect('42', '42')).toBe(true);
    expect(isAnswerCorrect('42 ', '42')).toBe(true); // trim
    expect(isAnswerCorrect('43', '42')).toBe(false);
  });
});

describe('isAnswerCorrect — multi-select', () => {
  test('exact set match', () => {
    expect(isAnswerCorrect(['A', 'C'], ['A', 'C'])).toBe(true);
  });

  test('order does not matter', () => {
    expect(isAnswerCorrect(['C', 'A'], ['A', 'C'])).toBe(true);
  });

  test('extra option is wrong', () => {
    expect(isAnswerCorrect(['A', 'B', 'C'], ['A', 'C'])).toBe(false);
  });

  test('missing option is wrong', () => {
    expect(isAnswerCorrect(['A'], ['A', 'C'])).toBe(false);
  });
});

// ── computeMarks ─────────────────────────────────────────────────────────────

describe('computeMarks', () => {
  test('correct answer earns full marks', () => {
    expect(computeMarks(true, true, 1, 0.25)).toBe(1);
  });

  test('wrong answer with negative marking deducts', () => {
    expect(computeMarks(false, true, 1, 0.25)).toBe(-0.25);
  });

  test('skipped question earns 0 even with negative marking', () => {
    expect(computeMarks(false, false, 1, 0.25)).toBe(0);
  });

  test('correct answer with zero negative marking earns full marks', () => {
    expect(computeMarks(true, true, 2, 0)).toBe(2);
  });
});

// ── computeAccuracy ──────────────────────────────────────────────────────────

describe('computeAccuracy', () => {
  test('all correct', () => {
    expect(computeAccuracy(10, 10)).toBe(100);
  });

  test('half correct', () => {
    expect(computeAccuracy(5, 10)).toBe(50);
  });

  test('none answered returns 0 (no division by zero)', () => {
    expect(computeAccuracy(0, 0)).toBe(0);
  });

  test('rounds to nearest integer', () => {
    // 1/3 = 33.33... → rounds to 33
    expect(computeAccuracy(1, 3)).toBe(33);
  });
});

// ── AI-generated question id filter (replicates the UUID guard in useAptitude) ─

function isRealUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

describe('isRealUuid', () => {
  test('valid uuid passes', () => {
    expect(isRealUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  test('ai- prefixed synthetic id is rejected', () => {
    expect(isRealUuid('ai-abc123')).toBe(false);
  });

  test('empty string is rejected', () => {
    expect(isRealUuid('')).toBe(false);
  });

  test('partial uuid is rejected', () => {
    expect(isRealUuid('550e8400-e29b-41d4')).toBe(false);
  });
});

// ── Question count filter after DB fetch ─────────────────────────────────────

function shuffleAndSlice<T>(arr: T[], count: number): T[] {
  return [...arr].sort(() => Math.random() - 0.5).slice(0, count);
}

describe('question count enforcement', () => {
  const questions = Array.from({ length: 20 }, (_, i) => ({ id: String(i) }));

  test('returns exactly the requested count when pool is larger', () => {
    const result = shuffleAndSlice(questions, 10);
    expect(result.length).toBe(10);
  });

  test('returns all when count exceeds pool', () => {
    const smallPool = questions.slice(0, 5);
    const result = shuffleAndSlice(smallPool, 10);
    expect(result.length).toBe(5);
  });

  test('returns 0 when pool is empty', () => {
    const result = shuffleAndSlice([], 10);
    expect(result.length).toBe(0);
  });
});

// ── Attempt status transitions ────────────────────────────────────────────────

type AttemptStatus = 'in_progress' | 'completed' | 'abandoned' | 'time_expired';

function resolveAttemptStatus(timeExpired: boolean): AttemptStatus {
  return timeExpired ? 'time_expired' : 'completed';
}

describe('attempt status resolution', () => {
  test('normal finish → completed', () => {
    expect(resolveAttemptStatus(false)).toBe('completed');
  });

  test('time expired finish → time_expired', () => {
    expect(resolveAttemptStatus(true)).toBe('time_expired');
  });
});
