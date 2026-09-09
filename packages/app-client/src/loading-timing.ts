import type { AnalyticsPort } from '@prismical/app-contracts';
import { EVENTS } from './analytics-events';

let sequence = 0;
const pageId = Math.random().toString(36).slice(2);
const phases = new Set([
  'persistence_ready',
  'notes_loaded',
  'notes_failed',
  'folders_loaded',
  'folders_failed',
  'tags_loaded',
  'tags_failed',
  'note_tags_loaded',
  'note_tags_failed',
  'create_gate_waiting',
  'create_gate_released',
  'provider_constructing',
  'provider_constructed',
  'socket_connecting',
  'socket_connected',
  'token_requested',
  'token_resolved',
  'token_missing',
  'authenticated',
  'document_synced',
  'local_log_hydrated',
  'editor_created',
  'editor_editability_set',
  'editor_dom_mounted',
  'editor_editable',
]);

export type LoadingKind = 'sync_bootstrap' | 'note_collaboration' | 'note_editor';

/** Diagnostic boundaries, not a navigation SLO. No content, credentials or error messages. */
export function startLoadingTiming(
  analytics: AnalyticsPort | undefined,
  kind: LoadingKind,
  noteId?: string,
  now: () => number = () => performance.now(),
  parentAttemptId?: string
) {
  const started = now();
  const attemptId = `${pageId}-${Date.now().toString(36)}-${++sequence}`;
  const milestones: Record<string, number> = {};
  const emitted = new Set<string>();
  let phaseCount = 0;
  let finished = false;
  // No retained browser buffer or network sink. A diagnostic tool opts in before
  // navigation and owns bounded collection/freeze. The event never includes input
  // content, credentials, errors, URL query strings, or WebSocket messages.
  const emitPhase = (phase: string, connectionAttempt?: number) => {
    try {
      if (
        typeof window === 'undefined' ||
        (window as Window & { __PRISMICAL_LOADING_PHASES__?: boolean })
          .__PRISMICAL_LOADING_PHASES__ !== true
      )
        return;
      const key = `${phase}:${connectionAttempt ?? ''}`;
      if (emitted.has(key) || phaseCount > 64) return;
      const monotonicMs = performance.now();
      const detail = {
        version: 1,
        kind,
        phase: phaseCount === 64 ? 'truncated' : phase,
        attemptId,
        ...(parentAttemptId && /^[a-z0-9-]{1,80}$/.test(parentAttemptId)
          ? { parentAttemptId }
          : {}),
        ...(noteId && /^nt_[a-z0-9]{12,40}$/.test(noteId) ? { noteId } : {}),
        ...(Number.isSafeInteger(connectionAttempt) && connectionAttempt! > 0
          ? { connectionAttempt }
          : {}),
        timeOriginMs: performance.timeOrigin,
        monotonicMs,
        elapsedMs: Math.round(now() - started),
      };
      phaseCount++;
      emitted.add(key);
      window.dispatchEvent(new CustomEvent('prismical:loading-phase', { detail }));
    } catch {
      /* An unavailable or broken recorder must not change product behavior. */
    }
  };
  const capture = (status: string) => {
    emitPhase(status);
    try {
      analytics?.capture(EVENTS.LOADING_TIMING, {
        kind,
        status,
        attempt_id: attemptId,
        note_id: noteId,
        client_at_ms: Date.now(),
        elapsed_ms: Math.round(now() - started),
        ...Object.fromEntries(Object.entries(milestones).map(([name, ms]) => [`${name}_ms`, ms])),
      });
    } catch {
      /* Diagnostics must not interrupt loading or cleanup. */
    }
  };
  capture('started');
  const timer = setTimeout(() => capture('pending_at_five_seconds'), 5000);
  return {
    attemptId,
    mark(name: string, connectionAttempt?: number) {
      if (finished || !phases.has(name)) return;
      if (!(name in milestones)) milestones[name] = Math.round(now() - started);
      emitPhase(name, connectionAttempt);
    },
    finish(status: 'ready' | 'published' | 'error' | 'abandoned') {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      capture(status);
    },
  };
}
