import { ApiError } from '../api/client';

const DEFAULT_TRANSCRIPT_RETRY_MS = 2_000;
const DEFAULT_MAX_TRANSCRIPT_RETRIES = 60;

function transcriptRetryMs(err: ApiError): number {
  const value = (err.details as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 250
    ? Math.min(value, 30_000)
    : DEFAULT_TRANSCRIPT_RETRY_MS;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

type RetryDelay = (ms: number, signal: AbortSignal) => Promise<void>;

/**
 * Retry only the server's explicit transcript-readiness backpressure. Every attempt is a fresh,
 * short HTTP request; model execution begins only after the server observes a terminal lifecycle.
 */
export async function retryTranscriptFinalizing<T>(
  call: () => Promise<T>,
  signal: AbortSignal,
  delay: RetryDelay = abortableDelay,
  maxRetries = DEFAULT_MAX_TRANSCRIPT_RETRIES
): Promise<T> {
  let retries = 0;
  while (true) {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'TRANSCRIPT_FINALIZING') throw err;
      if (retries >= maxRetries) throw err;
      retries += 1;
      await delay(transcriptRetryMs(err), signal);
    }
  }
}
