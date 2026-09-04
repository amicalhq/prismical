/**
 * Preload recording-state buffer — the exact analogue of
 * the session buffer for the recording:stateChanged push.
 *
 * A `webContents.send` to a channel with NO attached ipcRenderer listener is
 * dropped by Electron. A recording state push can fire before the shell's
 * useRecording subscribes (a recording already running when the note view mounts,
 * a detection-started recording), so the underlying listener attaches once
 * at preload evaluation time (wired in preload/main.ts). Pure + electron-free so
 * it is unit-testable.
 *
 * Contract — onStateChanged(listener) => unsubscribe:
 * - while NO subscriber exists, pushes buffer; the next subscriber replays that
 *   backlog in order (cold-start correctness);
 * - a subscriber attaching while others exist immediately receives the LATEST
 *   state (RecordingState is a snapshot — interim history is not replayed);
 * - every attached subscriber receives every subsequent push;
 * - subscribing NEVER detaches an existing subscriber; unsubscribe removes only
 *   its own listener.
 */
import type { RecordingStateView } from '@prismical/desktop-contracts';

export interface RecordingBufferIpc {
  /** Attach the raw state-changed source once (at construction). */
  readonly on: (listener: (state: RecordingStateView) => void) => void;
}

export interface RecordingBuffer {
  readonly onStateChanged: (listener: (state: RecordingStateView) => void) => () => void;
}

export const makeRecordingBuffer = (ipc: RecordingBufferIpc): RecordingBuffer => {
  const pending: RecordingStateView[] = [];
  const subscribers = new Set<(state: RecordingStateView) => void>();
  let latest: RecordingStateView | null = null;

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
    onStateChanged: listener => {
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
