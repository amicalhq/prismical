import type { NativeRecordingState } from '@prismical/app-contracts';
import type { EnvDescriptor, RecordingStateView } from '@prismical/desktop-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopPorts } from '../../src/renderer/main/app/ports/desktop-ports';

vi.mock('../../src/renderer/main/app/router', () => ({ router: {} }));
vi.mock('../../src/renderer/main/app/analytics/posthog', () => ({
  desktopAnalyticsPort: {}, resetAnalyticsIdentity: vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

const env: EnvDescriptor = {
  appMode: 'local', platform: 'darwin', appVersion: '0.0.0-test',
  noteWsUrl: 'wss://note.test', webAppOrigin: 'https://app.test',
  analyticsKey: null, analyticsHost: null, applicationLocale: 'en', systemLocale: 'en',
};

describe('desktop recording port', () => {
  it('returns the completion claim accepted by main', async () => {
    const claimCompletion = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.stubGlobal('window', { desktop: { recording: { claimCompletion } } });
    const control = createDesktopPorts(env).appPorts.recording.control!;
    expect(await control.claimCompletion('rec_1')).toBe(true);
    expect(await control.claimCompletion('rec_1')).toBe(false);
    expect(claimCompletion.mock.calls).toEqual([[{ recordingId: 'rec_1' }], [{ recordingId: 'rec_1' }]]);
  });

  it('delivers native auto-stop requests and their reset to the shared recording control', () => {
    let push: ((state: RecordingStateView) => void) | undefined;
    const unsubscribe = vi.fn();
    vi.stubGlobal('window', { desktop: { recording: {
      onStateChanged: (listener: (state: RecordingStateView) => void) => {
        push = listener;
        return unsubscribe;
      },
    } } });
    const seen: NativeRecordingState[] = [];
    const detach = createDesktopPorts(env).appPorts.recording.control!.subscribe(state => seen.push(state));
    const paused: RecordingStateView = {
      recordingId: 'rec_1', noteId: 'note_1', status: 'paused', captureMode: 'dual',
      requestedCaptureMode: 'dual', micSource: 'system-default', segments: [], elapsedMs: 30_000,
      autoStopRequested: true, autoPausePrompt: { graceMs: 5_000, deadlineMs: 35_000 },
    };
    push!(paused);
    push!({ ...paused, status: 'idle', autoStopRequested: false, autoPausePrompt: null });
    expect(seen.map(state => state.autoStopRequested)).toEqual([true, false]);
    expect(seen[0].autoPausePrompt).toBeUndefined();
    detach();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
