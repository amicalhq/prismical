/**
 * Preload session-view buffer (multi-subscriber because the nav buffer's
 * single-subscriber slot silently detached the
 * previous listener, which bit the sentinel spec and would bite the shell
 * mounting beside the gate).
 *
 * A `webContents.send` to a channel with NO attached ipcRenderer listener is
 * dropped by Electron. Session pushes can fire before the renderer subscribes
 * (a fast sign-in completion, the restore-refresh resolving during load), so
 * the underlying listener attaches ONCE at preload evaluation time (wired in
 * preload/main.ts). Pure + electron-free so it is unit-testable.
 *
 * Contract — onSessionChanged(listener) => unsubscribe:
 * - while NO subscriber exists, pushes buffer; the next subscriber replays
 *   that backlog in order (cold-start correctness);
 * - a subscriber attaching while others are already attached immediately
 *   receives the LATEST view (SessionView is a state snapshot — interim
 *   history is not replayed to late subscribers);
 * - every attached subscriber receives every subsequent push;
 * - subscribing NEVER detaches an existing subscriber; unsubscribe removes
 *   only its own listener.
 */
import type { SessionView } from '@prismical/desktop-contracts';

export interface SessionBufferIpc {
  /** Attach the raw session-changed source once (at construction). */
  readonly on: (listener: (view: SessionView) => void) => void;
}

export interface SessionBuffer {
  readonly onSessionChanged: (listener: (view: SessionView) => void) => () => void;
}

export const makeSessionBuffer = (ipc: SessionBufferIpc): SessionBuffer => {
  const pending: SessionView[] = [];
  const subscribers = new Set<(view: SessionView) => void>();
  let latest: SessionView | null = null;

  ipc.on(view => {
    latest = view;
    if (subscribers.size === 0) {
      pending.push(view);
      return;
    }
    // Snapshot: a listener unsubscribing (or subscribing) mid-fan-out must
    // not perturb this delivery round.
    for (const listener of [...subscribers]) listener(view);
  });

  return {
    onSessionChanged: listener => {
      // Backlog only accumulates while there were ZERO subscribers, so it can
      // only be non-empty for the first subscriber after such a gap.
      const backlog = pending.splice(0, pending.length);
      subscribers.add(listener);
      if (backlog.length > 0) {
        for (const view of backlog) listener(view);
      } else if (latest !== null) {
        // Late subscriber: seed it with the current view so it never renders
        // from nothing while others are already live.
        listener(latest);
      }
      return () => {
        subscribers.delete(listener);
      };
    },
  };
};
