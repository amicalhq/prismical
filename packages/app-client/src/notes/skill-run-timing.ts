import type { AnalyticsPort, AnalyticsEventProperties } from '@prismical/app-contracts';
import { EVENTS } from '../analytics-events';

let timingSequence = 0;

// Correlation only, never an authorization or idempotency key. Instrumentation must
// also work in renderer contexts without the secure-context randomUUID API.
function timingId(): string {
  try {
    const id = globalThis.crypto?.randomUUID?.();
    if (id) return id;
  } catch { /* Use a local correlation ID if the platform API is unavailable. */ }
  return `timing-${Date.now().toString(36)}-${++timingSequence}-${Math.random().toString(36).slice(2)}`;
}

export function requestSkillRunTiming(
  analytics: AnalyticsPort | undefined,
  identity: AnalyticsEventProperties
) {
  const intent = { attemptId: timingId(), requestedAt: performance.now() };
  try {
    analytics?.capture(EVENTS.SKILL_RUN_REQUESTED, {
      ...identity,
      attempt_id: intent.attemptId,
      client_at_ms: Date.now(),
    });
  } catch {
    /* Best effort. */
  }
  return intent;
}

type Phase = 'preparing' | 'request' | 'waiting-transcript' | 'staging';

/** Client timings stop when a suggestion is staged, not when the user later accepts it.
 * Missing terminal events can identify interrupted sessions; analytics delivery is best effort.
 * Request time includes transport and server work, not just model generation.
 */
export function startSkillRunTiming(
  analytics: AnalyticsPort,
  identity: AnalyticsEventProperties,
  now: () => number = () => performance.now(),
  requestedAt?: number,
  existingAttemptId?: string
) {
  const runStarted = now();
  const started =
    requestedAt !== undefined && Number.isFinite(requestedAt)
      ? Math.min(requestedAt, runStarted)
      : runStarted;
  const queuedMs = runStarted - started;
  const attemptId = existingAttemptId ?? requestSkillRunTiming(analytics, identity).attemptId;
  // One retained request can execute again after its editor remounts.
  const executionId = timingId();
  let phase: Phase = 'preparing';
  let phaseStarted = started;
  let finished = false;
  let requests = 0;
  let requestId: string | null = null;
  let modelId: string | undefined;
  const durations: Record<Phase, number> = {
    preparing: 0,
    request: 0,
    'waiting-transcript': 0,
    staging: 0,
  };
  const capture = (event: string, extra: AnalyticsEventProperties) => {
    try {
      analytics.capture(event, {
        ...identity,
        attempt_id: attemptId,
        execution_id: executionId,
        client_at_ms: Date.now(),
        ...extra,
      });
    } catch {
      /* Telemetry must never interrupt a skill run. */
    }
  };
  capture(EVENTS.SKILL_RUN_STARTED, { queued_ms: Math.round(queuedMs) });
  const transition = (next: Phase) => {
    if (finished) return;
    const at = now();
    durations[phase] += at - phaseStarted;
    phaseStarted = at;
    phase = next;
    capture(EVENTS.SKILL_RUN_PHASE, { phase, elapsed_ms: Math.round(at - started) });
  };
  return {
    transition,
    request() {
      requestId = null;
      requests++;
      transition('request');
    },
    response(id: string | null) {
      requestId = id;
    },
    model(id: string) {
      modelId = id;
    },
    finish(status: string, errorCode?: string) {
      if (finished) return;
      const ended = now();
      durations[phase] += ended - phaseStarted;
      finished = true;
      capture(EVENTS.SKILL_RUN_FINISHED, {
        status,
        error_code: errorCode,
        request_id: requestId,
        model_id: modelId,
        duration_ms: Math.round(ended - started),
        execution_duration_ms: Math.round(ended - runStarted),
        queued_ms: Math.round(queuedMs),
        preparing_ms: Math.round(durations.preparing),
        request_ms: Math.round(durations.request),
        transcript_wait_ms: Math.round(durations['waiting-transcript']),
        staging_ms: Math.round(durations.staging),
        request_count: requests,
      });
    },
  };
}
