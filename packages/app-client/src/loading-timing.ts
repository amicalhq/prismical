import type { AnalyticsPort } from '@prismical/app-contracts';
import { EVENTS } from './analytics-events';

let sequence = 0;

/** Diagnostic boundaries, not a navigation SLO. No content, credentials or error messages. */
export function startLoadingTiming(
  analytics: AnalyticsPort | undefined,
  kind: 'sync_bootstrap' | 'note_collaboration',
  noteId?: string,
  now: () => number = () => performance.now()
) {
  const started = now();
  const attemptId = `${Date.now().toString(36)}-${++sequence}`;
  const milestones: Record<string, number> = {};
  let finished = false;
  const capture = (status: string) => {
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
    mark(name: string) {
      if (!finished && !(name in milestones)) milestones[name] = Math.round(now() - started);
    },
    finish(status: 'ready' | 'published' | 'error' | 'abandoned') {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      capture(status);
    },
  };
}
