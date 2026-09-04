/**
 * Preload nav-push buffer.
 *
 * A `webContents.send` to a channel with NO attached ipcRenderer listener is
 * dropped by Electron. The old preload attached its nav:push listener lazily —
 * only when the renderer called nav.onPush — so a cold-start deep-link
 * navigation (open-url/argv → Navigate, dispatched before the SPA subscribes)
 * was lost.
 *
 * Fix: attach the underlying listener ONCE at preload evaluation time (see
 * ipc.on below, wired in preload/main.ts) and buffer payloads until a
 * subscriber exists. The first onPush subscriber replays the backlog, then
 * receives live pushes. Pure + electron-free so it is unit-testable.
 *
 * Contract (unchanged for callers): onPush(listener) => unsubscribe. Latest
 * subscriber wins; while there is no subscriber, pushes buffer and are replayed
 * on the next subscription.
 */
import type { NavPush } from '@prismical/desktop-contracts';

export interface NavBufferIpc {
  /** Attach the raw nav-push source once (at construction). */
  readonly on: (listener: (payload: NavPush) => void) => void;
}

export interface NavBuffer {
  readonly onPush: (listener: (payload: NavPush) => void) => () => void;
}

export const makeNavBuffer = (ipc: NavBufferIpc): NavBuffer => {
  const pending: NavPush[] = [];
  let subscriber: ((payload: NavPush) => void) | null = null;

  ipc.on(payload => {
    if (subscriber) subscriber(payload);
    else pending.push(payload);
  });

  return {
    onPush: listener => {
      subscriber = listener;
      // Replay anything that arrived before this subscription (cold start).
      const backlog = pending.splice(0, pending.length);
      for (const payload of backlog) listener(payload);
      return () => {
        if (subscriber === listener) subscriber = null;
      };
    },
  };
};
