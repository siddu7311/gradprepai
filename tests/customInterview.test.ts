/**
 * Custom Interview — unit tests
 *
 * Pure logic tests — no DOM, Supabase, or network calls.
 */
import { describe, expect, test } from 'bun:test';

// ── File size limit (mirrors MAX_FILE_MB = 20 in CustomInterview.tsx) ─────────

const MAX_FILE_MB = 20;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

function isFileSizeValid(bytes: number): boolean {
  return bytes > 0 && bytes <= MAX_FILE_BYTES;
}

describe('custom interview file size validation', () => {
  test('file within limit is valid', () => {
    expect(isFileSizeValid(5 * 1024 * 1024)).toBe(true); // 5 MB
  });

  test('file at exact limit is valid', () => {
    expect(isFileSizeValid(MAX_FILE_BYTES)).toBe(true);
  });

  test('file one byte over limit is invalid', () => {
    expect(isFileSizeValid(MAX_FILE_BYTES + 1)).toBe(false);
  });

  test('zero-byte file is invalid', () => {
    expect(isFileSizeValid(0)).toBe(false);
  });
});

// ── Supported file extension check ───────────────────────────────────────────

const ACCEPTED_EXTENSIONS = ['.pdf', '.docx', '.doc', '.txt', '.md', '.csv', '.json'];

function isAcceptedFileType(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

describe('custom interview file type validation', () => {
  test('PDF is accepted', () => expect(isAcceptedFileType('questions.pdf')).toBe(true));
  test('DOCX is accepted', () => expect(isAcceptedFileType('questions.docx')).toBe(true));
  test('DOC is accepted', () => expect(isAcceptedFileType('questions.doc')).toBe(true));
  test('TXT is accepted', () => expect(isAcceptedFileType('questions.txt')).toBe(true));
  test('MD is accepted', () => expect(isAcceptedFileType('readme.md')).toBe(true));
  test('CSV is accepted', () => expect(isAcceptedFileType('questions.csv')).toBe(true));
  test('JSON is accepted', () => expect(isAcceptedFileType('questions.json')).toBe(true));
  test('PNG is rejected', () => expect(isAcceptedFileType('diagram.png')).toBe(false));
  test('EXE is rejected', () => expect(isAcceptedFileType('malware.exe')).toBe(false));
  test('XLSX is rejected (not in supported list)', () => expect(isAcceptedFileType('sheet.xlsx')).toBe(false));
});

// ── Question count selection (subset from full set) ───────────────────────────

function selectQuestions<T>(pool: T[], count: number): T[] {
  if (count >= pool.length) return [...pool];
  // Fixed-seed deterministic selection for test predictability
  const shuffled = [...pool].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return shuffled.slice(0, count);
}

describe('question count selection', () => {
  const pool = [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }, { id: '5' }];

  test('selecting fewer than pool size returns the requested count', () => {
    expect(selectQuestions(pool, 3).length).toBe(3);
  });

  test('selecting more than pool size returns entire pool', () => {
    expect(selectQuestions(pool, 10).length).toBe(5);
  });

  test('selecting 0 returns empty array', () => {
    expect(selectQuestions(pool, 0).length).toBe(0);
  });

  test('original pool is not mutated', () => {
    selectQuestions(pool, 3);
    expect(pool.length).toBe(5);
  });
});

// ── Processing status machine ─────────────────────────────────────────────────

type ProcessingStatus = 'pending' | 'processing' | 'ready' | 'error';

function isTerminalStatus(status: ProcessingStatus): boolean {
  return status === 'ready' || status === 'error';
}

function canStartInterview(status: ProcessingStatus): boolean {
  return status === 'ready';
}

describe('processing status', () => {
  test('ready is terminal', () => expect(isTerminalStatus('ready')).toBe(true));
  test('error is terminal', () => expect(isTerminalStatus('error')).toBe(true));
  test('pending is not terminal', () => expect(isTerminalStatus('pending')).toBe(false));
  test('processing is not terminal', () => expect(isTerminalStatus('processing')).toBe(false));
  test('only ready allows starting interview', () => {
    expect(canStartInterview('ready')).toBe(true);
    expect(canStartInterview('pending')).toBe(false);
    expect(canStartInterview('processing')).toBe(false);
    expect(canStartInterview('error')).toBe(false);
  });
});

// ── Question-set ownership check ──────────────────────────────────────────────

interface QuestionSet {
  id: string;
  user_id: string;
  is_admin_set: boolean;
  is_published: boolean;
}

function canUserAccess(set: QuestionSet, userId: string): boolean {
  // User owns it, or it is a published admin set
  return set.user_id === userId || (set.is_admin_set && set.is_published);
}

describe('question set access control', () => {
  const userA = 'user-a-uuid';
  const userB = 'user-b-uuid';

  const userASet: QuestionSet = { id: 's1', user_id: userA, is_admin_set: false, is_published: false };
  const publishedAdminSet: QuestionSet = { id: 's2', user_id: 'admin-uuid', is_admin_set: true, is_published: true };
  const unpublishedAdminSet: QuestionSet = { id: 's3', user_id: 'admin-uuid', is_admin_set: true, is_published: false };

  test('user can access their own set', () => {
    expect(canUserAccess(userASet, userA)).toBe(true);
  });

  test('user cannot access another user set', () => {
    expect(canUserAccess(userASet, userB)).toBe(false);
  });

  test('published admin set is accessible to any user', () => {
    expect(canUserAccess(publishedAdminSet, userB)).toBe(true);
  });

  test('unpublished admin set is not accessible to regular users', () => {
    expect(canUserAccess(unpublishedAdminSet, userB)).toBe(false);
  });
});

// ── Interview mode validation ─────────────────────────────────────────────────

type InterviewMode = 'exact' | 'with_followups' | 'generated' | 'mixed';

function isValidInterviewMode(value: string): value is InterviewMode {
  return ['exact', 'with_followups', 'generated', 'mixed'].includes(value);
}

describe('interview mode validation', () => {
  test('all defined modes are valid', () => {
    const modes: InterviewMode[] = ['exact', 'with_followups', 'generated', 'mixed'];
    modes.forEach((m) => expect(isValidInterviewMode(m)).toBe(true));
  });

  test('undefined mode is invalid', () => {
    expect(isValidInterviewMode('freestyle')).toBe(false);
    expect(isValidInterviewMode('')).toBe(false);
  });
});
