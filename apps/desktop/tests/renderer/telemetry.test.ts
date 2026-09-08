import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelemetryState } from '@prismical/desktop-contracts';
import { desktopAnalyticsPort } from '../../src/renderer/main/app/analytics/posthog';
import { captureRendererException, getTelemetryState, installRendererTelemetry, rendererError } from '../../src/renderer/telemetry';

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
const enabled: TelemetryState = { revision: 1, available: true, enabled: true, signedIn: false, preference: true, canChangePreference: true };

function mount(state = enabled) {
  const capture = vi.fn().mockResolvedValue(undefined);
  const captureException = vi.fn().mockResolvedValue(undefined);
  const listeners = new Map<string, (event: unknown) => void>();
  let push: (state: TelemetryState) => void = () => {};
  const api = {
    capture, captureException,
    getState: vi.fn(async () => state),
    onChanged: (listener: typeof push) => { push = listener; listener(state); return () => {}; },
  };
  vi.stubGlobal('window', {
    desktop: { telemetry: api },
    addEventListener: (name: string, listener: (event: unknown) => void) => { listeners.set(name, listener); },
    removeEventListener: (name: string) => { listeners.delete(name); },
  });
  stop = installRendererTelemetry(api);
  return { api, listeners, push: (next: TelemetryState) => push(next) };
}

describe('renderer telemetry relay', () => {
  it('stamps emission revision and consumes rejected IPC calls', async () => {
    const { api } = mount();
    api.capture.mockRejectedValue(new Error('window closing'));
    desktopAnalyticsPort.capture('recording_completed', { recording_id: 'rec_1' });
    desktopAnalyticsPort.capturePageview('prismical-app://bundle/notes');
    await Promise.resolve();
    expect(api.capture.mock.calls).toEqual([
      [{ event: 'recording_completed', properties: { recording_id: 'rec_1' }, revision: 1 }],
      [{ event: 'page_viewed', properties: { route: 'main' }, revision: 1 }],
    ]);
  });

  it('reduces private route locations to a fixed page category', () => {
    const { api } = mount();
    desktopAnalyticsPort.capturePageview('prismical-app://bundle/index.html#/notes/private-note?token=secret');
    desktopAnalyticsPort.capturePageview('prismical-app://bundle/index.html#/settings/advanced');
    desktopAnalyticsPort.capturePageview('invalid location with private text');
    expect(api.capture.mock.calls).toEqual([
      [{ event: 'page_viewed', properties: { route: 'note' }, revision: 1 }],
      [{ event: 'page_viewed', properties: { route: 'settings' }, revision: 1 }],
      [{ event: 'page_viewed', properties: { route: 'unknown' }, revision: 1 }],
    ]);
  });

  it('projects safe source frames without forwarding messages or arbitrary properties', () => {
    const error = Object.assign(new Error('private transcript'), { token: 'secret', response: { body: 'private' } });
    error.stack = 'Error: private transcript\n    at render (prismical-app://bundle/assets/index.js:12:34)';
    const projected = rendererError(error);
    expect(JSON.stringify(projected)).not.toMatch(/private|transcript|token|secret/);
    expect(projected.frames).toEqual([expect.objectContaining({ filename: 'assets/index.js', lineno: 12, colno: 34 })]);
  });

  it('deduplicates boundary and uncaught observers of the same error', async () => {
    const { api, listeners } = mount();
    api.captureException.mockRejectedValue(new Error('window closing'));
    const error = new Error('failed');
    listeners.get('error')!({ error });
    listeners.get('unhandledrejection')!({ reason: error });
    captureRendererException(api, error, 'react_error_boundary');
    await Promise.resolve();
    expect(api.captureException).toHaveBeenCalledTimes(1);
    expect(api.captureException.mock.calls[0][0].properties).toEqual({ error_context: 'uncaught_exception' });
    stop!(); stop = undefined;
    expect(listeners.size).toBe(0);
  });

  it('drops events before the initial policy arrives without replaying them later', () => {
    const capture = vi.fn().mockResolvedValue(undefined);
    let push: (state: TelemetryState) => void = () => {};
    const api = {
      capture, captureException: vi.fn().mockResolvedValue(undefined),
      getState: () => new Promise<TelemetryState>(() => {}),
      onChanged: (listener: typeof push) => { push = listener; return () => {}; },
    };
    vi.stubGlobal('window', { desktop: { telemetry: api }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    stop = installRendererTelemetry(api);
    desktopAnalyticsPort.capture('recording_completed');
    expect(capture).not.toHaveBeenCalled();
    push(enabled);
    expect(capture).not.toHaveBeenCalled();
    desktopAnalyticsPort.capture('recording_completed');
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('does not replace a newer identity projection with an older query result', async () => {
    const { api, push } = mount();
    push({ ...enabled, revision: 2, signedIn: true, canChangePreference: false });
    await Promise.resolve();
    expect(getTelemetryState()?.revision).toBe(2);
    desktopAnalyticsPort.capture('recording_completed');
    expect(api.capture.mock.calls[0][0].revision).toBe(2);
    push({ ...enabled, revision: 3, enabled: false });
    desktopAnalyticsPort.capture('recording_completed');
    expect(api.capture).toHaveBeenCalledTimes(1);
  });

  it('recovers from an initial policy request failure without replaying dropped events', async () => {
    vi.useFakeTimers();
    const api = {
      capture: vi.fn().mockResolvedValue(undefined),
      captureException: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockRejectedValueOnce(new Error('IPC unavailable')).mockResolvedValue(enabled),
      onChanged: vi.fn(() => () => {}),
    };
    vi.stubGlobal('window', { desktop: { telemetry: api }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    stop = installRendererTelemetry(api);
    desktopAnalyticsPort.capture('recording_completed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(getTelemetryState()).toEqual(enabled);
    expect(api.capture).not.toHaveBeenCalled();
    desktopAnalyticsPort.capture('recording_completed');
    expect(api.capture).toHaveBeenCalledWith({ event: 'recording_completed', properties: undefined, revision: 1 });
    expect(api.onChanged).toHaveBeenCalledTimes(1);
  });

  it('cancels initial policy recovery when the renderer is disposed', async () => {
    vi.useFakeTimers();
    const api = {
      captureException: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockRejectedValue(new Error('IPC unavailable')),
      onChanged: vi.fn(() => () => {}),
    };
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    stop = installRendererTelemetry(api);
    await vi.advanceTimersByTimeAsync(0);
    stop(); stop = undefined;
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.getState).toHaveBeenCalledTimes(1);
    expect(getTelemetryState()).toBeNull();
  });
});
