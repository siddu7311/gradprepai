import { FunctionsHttpError } from '@supabase/supabase-js';

export async function getSupabaseFunctionErrorMessage(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body: unknown = await error.context.clone().json();
      if (typeof body === 'object' && body !== null && 'error' in body) {
        const message = (body as { error?: unknown }).error;
        if (typeof message === 'string' && message.trim()) return message;
      }
    } catch {
      // The function may return a non-JSON gateway error.
    }
  }

  return error instanceof Error ? error.message : 'The request could not be completed.';
}
