/**
 * Preload device-settings buffer — the exact analogue of
 * the session/recording buffers for the settings:changed push.
 *
 * A `webContents.send` to a channel with NO attached ipcRenderer listener is
 * dropped by Electron. The settings push fires immediately on handler registration
 * (SubscriptionRef.changes replays the current settings) — before any settings
 * screen subscribes — so the underlying listener attaches ONCE at preload
 * evaluation time (wired in preload/main.ts). Pure + electron-free so it is
 * unit-testable.
 *
 * Contract — onChanged(listener) => unsubscribe:
 * - while NO subscriber exists, pushes buffer; the next subscriber replays that
 *   backlog in order (cold-start correctness);
 * - a subscriber attaching while others exist immediately receives the LATEST
 *   settings (DeviceSettings is a snapshot — interim history is not replayed);
 * - every attached subscriber receives every subsequent push;
 * - subscribing NEVER detaches an existing subscriber; unsubscribe removes only
 *   its own listener.
 */
import type { DeviceSettings } from '@prismical/desktop-contracts';

export interface SettingsBufferIpc {
  /** Attach the raw settings-changed source once (at construction). */
  readonly on: (listener: (settings: DeviceSettings) => void) => void;
}

export interface SettingsBuffer {
  readonly onChanged: (listener: (settings: DeviceSettings) => void) => () => void;
}

export const makeSettingsBuffer = (ipc: SettingsBufferIpc): SettingsBuffer => {
  const pending: DeviceSettings[] = [];
  const subscribers = new Set<(settings: DeviceSettings) => void>();
  let latest: DeviceSettings | null = null;

  ipc.on(settings => {
    latest = settings;
    if (subscribers.size === 0) {
      pending.push(settings);
      return;
    }
    // Snapshot: a listener unsubscribing (or subscribing) mid-fan-out must not
    // perturb this delivery round.
    for (const listener of [...subscribers]) listener(settings);
  });

  return {
    onChanged: listener => {
      const backlog = pending.splice(0, pending.length);
      subscribers.add(listener);
      if (backlog.length > 0) {
        for (const settings of backlog) listener(settings);
      } else if (latest !== null) {
        listener(latest);
      }
      return () => {
        subscribers.delete(listener);
      };
    },
  };
};
