import { ApiError } from '../api/client';

const DEFAULT_TRANSCRIPT_RETRY_MS = 2_000;
/**
 * Wall-clock budget when the server sends no deadline (a core that predates `deadlineMs`).
 * Sized past the server's own spool wait (5 min) plus its stalled-spool release grace (10 min):
 * the old fixed count of 60 × 2 s (2m24s) gave up 74 s before the incident's transcript landed.
 */
export const DEFAULT_TRANSCRIPT_WAIT_MS = 15 * 60_000;
/** Never wait longer than this even if the server asks — a client is not a durable queue. */
export const MAX_TRANSCRIPT_WAIT_MS = 30 * 60_000;

function transcriptRetryMs(err: ApiError): number {
  const value = (err.details as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 250
    ? Math.min(value, 30_000)
    : DEFAULT_TRANSCRIPT_RETRY_MS;
}

/**
 * The server's own release deadline for this recording, as a wait budget from now. The first
 * 409 fixes it: later responses only ever move it earlier (a settled stitch shortens the
 * remaining allowance), never later, so a server bug cannot keep a run parked forever.
 */
function transcriptDeadlineMs(err: ApiError): number | undefined {
  const value = (err.details as { deadlineMs?: unknown } | undefined)?.deadlineMs;
  // A non-positive deadline is a server whose schedule fell behind, not an instruction to give
  // up on the first attempt: ignore it and keep the client's own budget.
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_TRANSCRIPT_WAIT_MS)
    : undefined;
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
 *
 * The budget is WALL-CLOCK, driven by the server: each 409 carries `retryAfterMs` (the drain's
 * own next due time) and `deadlineMs` (when the server will have released the recording one way
 * or another). Reaching the deadline rethrows the last 409 — the caller parks the run; it is not
 * a failure, and the server's work continues regardless.
 */
export async function retryTranscriptFinalizing<T>(
  call: () => Promise<T>,
  signal: AbortSignal,
  delay: RetryDelay = abortableDelay,
  opts: { now?: () => number; defaultWaitMs?: number } = {}
): Promise<T> {
  const now = opts.now ?? Date.now;
  const started = now();
  let deadlineAt: number | undefined;
  while (true) {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'TRANSCRIPT_FINALIZING') throw err;
      const advertised = transcriptDeadlineMs(err);
      const candidate =
        now() + (advertised ?? (deadlineAt === undefined
          ? (opts.defaultWaitMs ?? DEFAULT_TRANSCRIPT_WAIT_MS)
          : Number.POSITIVE_INFINITY));
      deadlineAt = deadlineAt === undefined ? candidate : Math.min(deadlineAt, candidate);
      // A hard ceiling from the first attempt, independent of what the server says.
      deadlineAt = Math.min(deadlineAt, started + MAX_TRANSCRIPT_WAIT_MS);
      const wait = transcriptRetryMs(err);
      if (now() + wait > deadlineAt) throw err;
      await delay(wait, signal);
    }
  }
}
