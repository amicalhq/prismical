import { AI_ERROR_CODES } from '@prismical/api-contracts';
import { reportClientError } from '../diagnostics';
import { askStreamFailureOf } from '../errors/ai-user-error';
import { AskSessionChangedError } from './transport';

const expectedCodes = new Set<string>([
  AI_ERROR_CODES.PROVIDER_KEY_INVALID, AI_ERROR_CODES.PROVIDER_KEY_MISSING,
  AI_ERROR_CODES.PROVIDER_QUOTA_EXCEEDED, AI_ERROR_CODES.PROVIDER_RATE_LIMITED,
  AI_ERROR_CODES.PROVIDER_MODEL_NOT_FOUND, AI_ERROR_CODES.PROVIDER_CONTEXT_TOO_LONG,
  AI_ERROR_CODES.PROVIDER_TOOLS_UNSUPPORTED, AI_ERROR_CODES.PROVIDER_REJECTED,
  AI_ERROR_CODES.MODEL_SELECTION_INVALID, AI_ERROR_CODES.INSTANCE_NOT_FOUND,
  AI_ERROR_CODES.BYOK_NOT_ALLOWED, AI_ERROR_CODES.ASK_NOT_IN_PLAN,
  AI_ERROR_CODES.AI_CREDITS_EXHAUSTED, AI_ERROR_CODES.BYOK_NOT_IN_PLAN,
  AI_ERROR_CODES.ASK_STEPS_EXHAUSTED, AI_ERROR_CODES.ASK_OUTPUT_TRUNCATED,
]);

/** useChat handles stream failures after HTTP 200, outside the API/query error reporters. */
export function reportAskError(error: Error): void {
  try {
    if (error instanceof AskSessionChangedError || error.name === 'AbortError') return;
    const failure = askStreamFailureOf(error);
    if (failure && expectedCodes.has(failure.code)) return;
    // The stream error can contain localized prose or a provider body. Report only its code.
    const safe = new Error('Unexpected Ask failure');
    safe.name = 'AskError';
    safe.stack = `${safe.name}: ${safe.message}\n${error.stack?.split('\n').filter(line => /^\s+at /.test(line)).join('\n') ?? ''}`;
    reportClientError(safe, { operation: 'ask_stream', error_code: failure?.code });
  } catch { /* Reporting cannot interfere with the existing retry/recovery UI. */ }
}
