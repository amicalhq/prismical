import type { NativeRecordingState } from '@prismical/app-contracts';
import type { EnvDescriptor, RecordingStateView } from '@prismical/desktop-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopPorts } from '../../src/renderer/main/app/ports/desktop-ports';

vi.mock('../../src/renderer/main/app/router', () => ({ router: {} }));
vi.mock('../../src/renderer/main/app/analytics/posthog', () => ({
  desktopAnalyticsPort: {},
}));

afterEach(() => vi.unstubAllGlobals());

const env: EnvDescriptor = {
  appMode: 'local', platform: 'darwin', appVersion: '0.0.0-test',
  noteWsUrl: 'wss://note.test', webAppOrigin: 'https://app.test',
  gleap: null,
  analyticsKey: null, analyticsHost: null, applicationLocale: 'en', systemLocale: 'en',
};

describe('desktop recording port', () => {
  it('forwards the cached quota baseline at Start and preserves an unavailable baseline', async () => {
    const start = vi.fn().mockResolvedValue({ ok: true, recordingId: 'rec_1' });
    vi.stubGlobal('window', { desktop: { recording: { start } } });
    const control = createDesktopPorts(env).appPorts.recording.control!;
    await control.start({ noteId: 'note_1', title: 'First note', quotaRemainingAtStartSeconds: 600 });
    await control.start({ noteId: 'note_2', title: 'Second note' });
    expect(start.mock.calls).toEqual([
      [{ captureMode: 'dual', noteId: 'note_1', title: 'First note', quotaRemainingAtStartSeconds: 600 }],
      [{ captureMode: 'dual', noteId: 'note_2', title: 'Second note', quotaRemainingAtStartSeconds: null }],
    ]);
  });

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
      finalizingRecordingIds: [], completedRecordings: [],
      recordingId: 'rec_1', noteId: 'note_1', status: 'paused', captureMode: 'dual',
      requestedCaptureMode: 'dual', micSource: 'system-default', segments: [], elapsedMs: 30_000,
      spendsCloudQuota: false,
      quotaRemainingAtStartSeconds: 600,
      autoStopRequested: true, autoPausePrompt: { graceMs: 5_000, deadlineMs: 35_000 },
    };
    push!(paused);
    push!({ ...paused, status: 'idle', autoStopRequested: false, autoPausePrompt: null,
      quotaRemainingAtStartSeconds: undefined });
    expect(seen.map(state => state.autoStopRequested)).toEqual([true, false]);
    expect(seen[0].autoPausePrompt).toEqual(paused.autoPausePrompt);
    expect(seen[0].spendsCloudQuota).toBe(false);
    expect(seen.map(state => state.quotaRemainingAtStartSeconds)).toEqual([600, null]);
    detach();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
