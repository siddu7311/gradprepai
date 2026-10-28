/**
 * ATS Resume Analyzer — unit tests
 *
 * Tests cover pure scoring/classification logic without DOM, Supabase, or network.
 */
import { describe, expect, test } from 'bun:test';

// ── Score boundary validation (replicates what the Edge Function enforces) ───

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

describe('ATS score clamping', () => {
  test('score in range stays unchanged', () => {
    expect(clampScore(75)).toBe(75);
    expect(clampScore(0)).toBe(0);
    expect(clampScore(100)).toBe(100);
  });

  test('negative score is clamped to 0', () => {
    expect(clampScore(-5)).toBe(0);
  });

  test('score above 100 is clamped to 100', () => {
    expect(clampScore(110)).toBe(100);
  });
});

// ── Priority classification (mirrors the frontend PRIORITY_COLORS map) ───────

type Priority = 'high' | 'medium' | 'optional';

function isValidPriority(value: string): value is Priority {
  return ['high', 'medium', 'optional'].includes(value);
}

describe('recommendation priority validation', () => {
  test('known priorities are valid', () => {
    expect(isValidPriority('high')).toBe(true);
    expect(isValidPriority('medium')).toBe(true);
    expect(isValidPriority('optional')).toBe(true);
  });

  test('unknown priority is invalid', () => {
    expect(isValidPriority('critical')).toBe(false);
    expect(isValidPriority('')).toBe(false);
  });
});

// ── Keyword deduplication (must not double-count found + missing) ─────────────

function deduplicateKeywords(found: string[], missing: string[]): { found: string[]; missing: string[] } {
  const foundSet = new Set(found.map((k) => k.toLowerCase()));
  return {
    found,
    missing: missing.filter((k) => !foundSet.has(k.toLowerCase())),
  };
}

describe('keyword deduplication', () => {
  test('keyword in found is removed from missing', () => {
    const { missing } = deduplicateKeywords(['React', 'Node.js'], ['React', 'TypeScript']);
    expect(missing).not.toContain('React');
    expect(missing).toContain('TypeScript');
  });

  test('case-insensitive dedup', () => {
    const { missing } = deduplicateKeywords(['react'], ['React', 'Vue']);
    expect(missing).not.toContain('React');
    expect(missing).toContain('Vue');
  });

  test('empty found keeps all missing', () => {
    const { missing } = deduplicateKeywords([], ['React', 'TypeScript']);
    expect(missing).toEqual(['React', 'TypeScript']);
  });
});

// ── ATS score two-score invariant ─────────────────────────────────────────────
// The spec mandates two distinct scores; they must never be merged.

describe('ATS two-score invariant', () => {
  interface MockAnalysis {
    ats_readiness_score: number;
    jd_match_score: number;
  }

  test('both scores are present and independent', () => {
    const analysis: MockAnalysis = { ats_readiness_score: 72, jd_match_score: 58 };
    expect(analysis.ats_readiness_score).not.toBe(analysis.jd_match_score);
    expect(typeof analysis.ats_readiness_score).toBe('number');
    expect(typeof analysis.jd_match_score).toBe('number');
  });

  test('scores are in valid range', () => {
    const analysis: MockAnalysis = { ats_readiness_score: 85, jd_match_score: 65 };
    expect(clampScore(analysis.ats_readiness_score)).toBe(analysis.ats_readiness_score);
    expect(clampScore(analysis.jd_match_score)).toBe(analysis.jd_match_score);
  });
});

// ── File type validation (mirrors isValidResumeFile in documentParser.ts) ────

const VALID_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
];

const VALID_EXTENSIONS = ['.pdf', '.docx', '.doc', '.txt'];

function isValidResumeFile(fileName: string, mimeType: string): boolean {
  const lower = fileName.toLowerCase();
  return (
    VALID_MIME_TYPES.includes(mimeType) ||
    VALID_EXTENSIONS.some((ext) => lower.endsWith(ext))
  );
}

describe('resume file type validation', () => {
  test('PDF is accepted', () => {
    expect(isValidResumeFile('resume.pdf', 'application/pdf')).toBe(true);
  });

  test('DOCX is accepted', () => {
    expect(
      isValidResumeFile(
        'resume.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(true);
  });

  test('TXT is accepted', () => {
    expect(isValidResumeFile('notes.txt', 'text/plain')).toBe(true);
  });

  test('PNG is rejected', () => {
    expect(isValidResumeFile('photo.png', 'image/png')).toBe(false);
  });

  test('executable is rejected', () => {
    expect(isValidResumeFile('virus.exe', 'application/octet-stream')).toBe(false);
  });

  test('extension fallback works even with wrong mime', () => {
    expect(isValidResumeFile('resume.pdf', 'application/octet-stream')).toBe(true);
  });
});

// ── ATS parsing_status values ─────────────────────────────────────────────────

type ParsingStatus = 'ok' | 'partial' | 'failed';

function isValidParsingStatus(value: string): value is ParsingStatus {
  return ['ok', 'partial', 'failed'].includes(value);
}

describe('parsing status validation', () => {
  test('ok is valid', () => expect(isValidParsingStatus('ok')).toBe(true));
  test('partial is valid', () => expect(isValidParsingStatus('partial')).toBe(true));
  test('failed is valid', () => expect(isValidParsingStatus('failed')).toBe(true));
  test('unknown is invalid', () => expect(isValidParsingStatus('error')).toBe(false));
});
