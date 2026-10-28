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

export function parseGeneratedQuestions(content: string): unknown[] | null {
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
