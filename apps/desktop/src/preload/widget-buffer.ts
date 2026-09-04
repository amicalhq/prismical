/**
 * Preload widget-state buffer — the exact analogue of the
 * recording buffer for the widget:state push.
 *
 * A `webContents.send` to a channel with NO attached ipcRenderer listener is
 * dropped by Electron. A state push can fire before the renderer subscribes
 * (a recording already in flight when the widget paints; a card minted before
 * the notify page loads), so the underlying listener attaches ONCE at preload
 * evaluation time (wired in preload/widget.ts + preload/notify.ts). Pure +
 * electron-free so it is unit-testable.
 *
 * Contract — onState(listener) => unsubscribe:
 * - while NO subscriber exists, pushes buffer; the next subscriber replays that
 *   backlog in order (cold-start correctness);
 * - a subscriber attaching while others exist immediately receives the LATEST
 *   state (the view is a snapshot — interim history is not replayed);
 * - every attached subscriber receives every subsequent push;
 * - subscribing NEVER detaches an existing subscriber; unsubscribe removes only
 *   its own listener.
 */
import type { WidgetStateView } from '@prismical/desktop-contracts';

export interface ReplayBufferIpc<T> {
  /** Attach the raw state source once (at construction). */
  readonly on: (listener: (state: T) => void) => void;
}

export interface ReplayBuffer<T> {
  readonly onState: (listener: (state: T) => void) => () => void;
}

export type WidgetBufferIpc = ReplayBufferIpc<WidgetStateView>;
export type WidgetBuffer = ReplayBuffer<WidgetStateView>;

/**
 * The notify window's card-stack push rides the
 * exact same cold-start replay semantics (notify preload), so the buffer is
 * type-parameterized; `makeWidgetBuffer` below keeps the original name for the
 * widget preload + tests.
 */
export const makeReplayBuffer = <T>(ipc: ReplayBufferIpc<T>): ReplayBuffer<T> => {
  const pending: T[] = [];
  const subscribers = new Set<(state: T) => void>();
  let latest: T | null = null;

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
    onState: listener => {
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

export const makeWidgetBuffer = (ipc: WidgetBufferIpc): WidgetBuffer =>
  makeReplayBuffer<WidgetStateView>(ipc);
