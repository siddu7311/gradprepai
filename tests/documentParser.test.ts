import { describe, expect, test } from 'bun:test';
import { extractTextFromFile } from '../src/lib/documentParser';

describe('custom interview document extraction', () => {
  test.each(['txt', 'md', 'csv', 'json'])('extracts text from .%s files', async (extension) => {
    const file = new File(['document text'], `questions.${extension}`);
    await expect(extractTextFromFile(file)).resolves.toBe('document text');
  });
});
