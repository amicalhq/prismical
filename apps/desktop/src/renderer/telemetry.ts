import type { MainWindowTelemetryApi, TelemetryError, TelemetryState } from '@prismical/desktop-contracts';
import { projectTelemetryException } from '../shared/telemetry-exception';

type ExceptionBridge = Pick<MainWindowTelemetryApi, 'captureException'>;
type TelemetryBridge = Pick<MainWindowTelemetryApi, 'captureException' | 'getState' | 'onChanged'>;
const seen = new WeakSet<object>();
let current: TelemetryState | null = null;
const subscribers = new Set<() => void>();

export const getTelemetryState = (): TelemetryState | null => current;
export const subscribeTelemetryState = (listener: () => void): (() => void) => {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
};
function applyState(next: TelemetryState): void {
  if (current !== null && next.revision <= current.revision) return;
  current = next;
  for (const listener of subscribers) listener();
}

export async function refreshTelemetryState(api: Pick<TelemetryBridge, 'getState'>): Promise<TelemetryState> {
  const next = await api.getState();
  applyState(next);
  return current!;
}

/** Parse safe source frames in their originating renderer, preserving chunk IDs. */
export function rendererError(error: unknown): TelemetryError {
  const projected = projectTelemetryException(error, 'renderer');
  return {
    name: projected.name,
    message: projected.message,
    ...(projected.stack === undefined ? {} : { stack: projected.stack }),
    frames: projected.frames,
  };
}

export function captureRendererException(api: ExceptionBridge, error: unknown, errorContext: string): void {
  if (!current?.enabled) return;
  if (typeof error === 'object' && error !== null) {
    if (seen.has(error)) return;
    seen.add(error);
  }
  void api.captureException({
    revision: current.revision,
    error: rendererError(error), properties: { error_context: errorContext },
  }).catch(() => {});
}

/** One boot-owned policy subscription and exception owner for each renderer. */
export function installRendererTelemetry(api: TelemetryBridge): () => void {
  let active = true;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const off = api.onChanged(next => { if (active) applyState(next); });
  const queryState = (): void => {
    void api.getState().then(next => { if (active) applyState(next); }).catch(() => {
      if (active && current === null) {
        retryTimer = setTimeout(() => {
          if (active && current === null) queryState();
        }, 1000);
      }
    });
  };
  queryState();
  const onError = (event: ErrorEvent): void => captureRendererException(api, event.error ?? event.message, 'uncaught_exception');
  const onRejection = (event: PromiseRejectionEvent): void => captureRendererException(api, event.reason, 'unhandled_rejection');
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    active = false;
    clearTimeout(retryTimer);
    off();
    current = null;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
