/**
 * Preload updater-view buffer — the exact analogue of the settings buffer
 * for the updater:stateChanged push.
 *
 * A `webContents.send` to a channel with NO attached ipcRenderer listener is
 * dropped by Electron. The updater push fires immediately on handler
 * registration (SubscriptionRef.changes replays the current view) — before any
 * settings screen subscribes — so the underlying listener attaches ONCE at
 * preload evaluation time (wired in preload/main.ts). Pure + electron-free so
 * it is unit-testable.
 *
 * Contract — onChanged(listener) => unsubscribe: identical to settings-buffer
 * (UpdateStateView is a snapshot; a late subscriber gets the LATEST view, a
 * cold-start subscriber replays the backlog in order).
 */
import type { UpdateStateView } from '@prismical/desktop-contracts';

export interface UpdaterBufferIpc {
  /** Attach the raw updater-state source once (at construction). */
  readonly on: (listener: (state: UpdateStateView) => void) => void;
}

export interface UpdaterBuffer {
  readonly onChanged: (listener: (state: UpdateStateView) => void) => () => void;
}

export const makeUpdaterBuffer = (ipc: UpdaterBufferIpc): UpdaterBuffer => {
  const pending: UpdateStateView[] = [];
  const subscribers = new Set<(state: UpdateStateView) => void>();
  let latest: UpdateStateView | null = null;

  ipc.on(state => {
    latest = state;
    if (subscribers.size === 0) {
      pending.push(state);
      return;
    }
    // Snapshot: a listener unsubscribing (or subscribing) mid-fan-out must not
    // perturb this delivery round.
    for (const listener of [...subscribers]) listener(state);
  });

  return {
    onChanged: listener => {
      const backlog = pending.splice(0, pending.length);
      subscribers.add(listener);
      if (backlog.length > 0) {
        for (const state of backlog) listener(state);
      } else if (latest !== null) {
        listener(latest);
      }
      return () => {
        subscribers.delete(listener);
      };
    },
  };
};
