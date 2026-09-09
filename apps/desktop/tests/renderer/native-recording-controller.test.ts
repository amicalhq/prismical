import { QueryClient } from '@tanstack/react-query';
import { createWorkflowRuntime } from '@prismical/app-workflow';
import type { AuthPort, NativeRecordingControl, NativeRecordingState, SessionView } from '@prismical/app-contracts';
import { describe, expect, it, vi } from 'vitest';
import { createNativeRecordingController } from '../../src/renderer/main/app/ports/native-recording-controller';

vi.mock('@prismical/app-client', async importOriginal => ({
  nativeNotice: (await importOriginal<typeof import('@prismical/app-client')>()).nativeNotice,
  activeOrgIdOf: (view: SessionView) => view.accounts[0]?.activeOrgId ?? null,
  ensureAutoPausePolicy: vi.fn(async () => ({ enabled: false })),
  getAutoEnhanceEnabled: () => true,
  usageKey: (orgId: string) => ['usage', orgId],
}));

const idle: NativeRecordingState = {
  status: 'idle', recordingId: null, noteId: null, captureMode: null,
  requestedCaptureMode: null, micSource: 'system-default', segments: [], elapsedMs: 0,
  finalizingRecordingIds: [], completedRecordings: [],
};
const capturing: NativeRecordingState = {
  ...idle, status: 'recording', recordingId: 'rec_1', noteId: 'note_1',
  captureMode: 'dual', requestedCaptureMode: 'dual', elapsedMs: 10_000, elapsedAt: 20_000,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(initial = idle) {
  let state = initial;
  let listener: ((value: NativeRecordingState) => void) | undefined;
  let authListener: ((view: SessionView) => void) | undefined;
  let view = { state: 'signed-in', activeSub: 'user_1', activeSessionKey: 'session_1',
    accounts: [{ sub: 'user_1', sessionKey: 'session_1', activeOrgId: 'org_1' }],
  } as unknown as SessionView;
  const offNative = vi.fn();
  const offAuth = vi.fn();
  const auth = {
    getSession: () => view,
    onSessionChanged: (fn: typeof authListener) => { authListener = fn; return offAuth; },
  } as unknown as AuthPort;
  const control: NativeRecordingControl = {
    start: vi.fn(async () => ({ ok: true as const, recordingId: 'rec_1' })),
    pause: vi.fn(async () => true), resume: vi.fn(async () => true),
    stop: vi.fn(async () => {}), claimCompletion: vi.fn(async () => true),
    subscribe: fn => { listener = fn; fn(state); return offNative; },
  };
  const workflow = createWorkflowRuntime();
  const client = createNativeRecordingController({ auth, control, workflow });
  const qc = new QueryClient();
  client.configure({ queryClient: qc });
  client.subscribe(() => {});
  return { client, control, workflow, qc, offNative, offAuth,
    push(value: NativeRecordingState) { state = value; listener?.(value); },
    switchOrg() {
      view = { ...view, accounts: [{ ...view.accounts[0]!, activeOrgId: 'org_2' }] };
      authListener?.(view);
    },
  };
}

describe('native recording workflow', () => {
  it('adopts capture after renderer reload and keeps its native clock and paused phase', () => {
    const f = fixture({ ...capturing, status: 'paused' });
    expect(f.workflow.getSnapshot()).toMatchObject({ kind: 'recording', phase: 'paused', recordingId: 'rec_1' });
    expect(f.client.getSnapshot()).toMatchObject({ isPaused: true, noteId: 'note_1',
      nativeElapsed: { status: 'paused', elapsedMs: 10_000, elapsedAt: 20_000 } });
    f.push(capturing);
    expect(f.workflow.getSnapshot()).toMatchObject({ phase: 'capturing' });
  });

  it('adopts a newer native recording when the previous terminal push was missed', () => {
    const f = fixture({ ...capturing, recordingId: 'rec_own_key', spendsCloudQuota: false });
    f.push({ ...capturing, recordingId: 'rec_cloud', spendsCloudQuota: true,
      quotaRemainingAtStartSeconds: 600, elapsedMs: 0, elapsedAt: 30_000 });
    expect(f.client.getSnapshot()).toMatchObject({ recordingId: 'rec_cloud', isRecording: true,
      nativeElapsed: { status: 'recording', elapsedMs: 0, elapsedAt: 30_000 } });
    expect(f.workflow.getSnapshot()).toMatchObject({ kind: 'recording', phase: 'capturing', recordingId: 'rec_cloud' });
    expect(f.control.stop).not.toHaveBeenCalled();
    expect(f.control.claimCompletion).not.toHaveBeenCalled();
  });

  it('attributes native silence pauses without duplicating the native prompt', () => {
    const f = fixture(capturing);
    f.push({ ...capturing, autoPausePrompt: { graceMs: 5000, deadlineMs: 30000 } });
    f.push({ ...capturing, status: 'paused', autoPausePrompt: null });
    expect(f.client.getSnapshot()).toMatchObject({ pauseReason: 'silence', gracePrompt: null });
  });

  it('blocks recording while a skill owns the workflow', async () => {
    const f = fixture();
    await f.workflow.request({ type: 'runSkill', workflowId: 'skill_1', noteId: 'note_1', skillId: 'enhance' });
    await f.client.start('note_2', 'Next note');
    expect(f.control.start).not.toHaveBeenCalled();
    expect(f.workflow.getSnapshot()).toMatchObject({ kind: 'skill', phase: 'running' });
  });

  it('passes the cached quota to main and admits pause and resume', async () => {
    const f = fixture();
    f.qc.setQueryData(['usage', 'org_1'], { quota: { cloudTranscription: { limitSeconds: 900, usedSeconds: 300 } } });
    await f.client.start('note_1', 'Meeting');
    expect(f.control.start).toHaveBeenCalledWith({ noteId: 'note_1', title: 'Meeting', quotaRemainingAtStartSeconds: 600 });
    f.push(capturing);
    expect(await f.client.pause()).toBe(true);
    expect(f.workflow.getSnapshot()).toMatchObject({ phase: 'paused' });
    expect(await f.client.resume()).toBe(true);
    expect(f.workflow.getSnapshot()).toMatchObject({ phase: 'capturing' });
  });

  it('allows retry when native pause rejects', async () => {
    const f = fixture(capturing);
    vi.mocked(f.control.pause).mockResolvedValueOnce(false);
    expect(await f.client.pause()).toBe(false);
    expect(f.workflow.getSnapshot()).toMatchObject({ phase: 'capturing', control: undefined });
    expect(await f.client.pause()).toBe(true);
    expect(f.workflow.getSnapshot()).toMatchObject({ phase: 'paused' });
  });

  it('retains finishing ownership until durable completion then enters enhancement once', async () => {
    const f = fixture(capturing);
    const claim = deferred<boolean>();
    vi.mocked(f.control.claimCompletion).mockReturnValue(claim.promise);
    await f.client.stop();
    expect(f.workflow.getSnapshot()).toMatchObject({ phase: 'draining' });
    f.push({ ...capturing, status: 'idle', finalizingRecordingIds: ['rec_1'] });
    expect(f.workflow.getSnapshot()).toMatchObject({ phase: 'finalizing' });
    await f.client.start('note_2', 'Next note');
    expect(f.control.start).not.toHaveBeenCalled();
    f.push({ ...capturing, status: 'idle', completedRecordings: [{ recordingId: 'rec_1', noteId: 'note_1', segments: 3 }] });
    expect(f.control.claimCompletion).toHaveBeenCalledOnce();
    claim.resolve(true);
    await vi.waitFor(() => expect(f.workflow.getSnapshot()).toMatchObject({ kind: 'skill', phase: 'running', recordingId: 'rec_1' }));
    expect(f.client.getSnapshot().completedRecording).toMatchObject({ recordingId: 'rec_1', noteId: 'note_1', segments: 3, workflowId: expect.any(String) });
  });

  it('does not enhance when another native window claimed completion', async () => {
    const f = fixture(capturing);
    vi.mocked(f.control.claimCompletion).mockResolvedValue(false);
    f.push({ ...capturing, status: 'idle' });
    await vi.waitFor(() => expect(f.workflow.getSnapshot()).toEqual({ kind: 'idle' }));
    expect(f.client.getSnapshot().completedRecording).toBeNull();
  });

  it('restores queued completion even when main has cleared the current recording', async () => {
    const f = fixture({ ...idle, completedRecordings: [{ recordingId: 'rec_old', noteId: 'note_old', segments: 4 }] });
    await vi.waitFor(() => expect(f.client.getSnapshot().completedRecording).toMatchObject({ recordingId: 'rec_old', segments: 4 }));
    expect(f.control.claimCompletion).toHaveBeenCalledWith('rec_old');
  });

  it('keeps onboarding completion idle when enhancement is skipped', async () => {
    const f = fixture(capturing);
    f.client.configure({ skipAutoEnhanceForNote: 'note_1' });
    f.push({ ...capturing, status: 'idle' });
    await vi.waitFor(() => expect(f.client.getSnapshot().completedRecording).not.toBeNull());
    expect(f.workflow.getSnapshot()).toEqual({ kind: 'idle' });
    expect(f.client.getSnapshot().completedRecording).not.toHaveProperty('workflowId');
  });

  it('discards late completion after the workspace changes', async () => {
    const f = fixture(capturing);
    const claim = deferred<boolean>();
    vi.mocked(f.control.claimCompletion).mockReturnValue(claim.promise);
    f.push({ ...capturing, status: 'idle' });
    f.switchOrg();
    claim.resolve(true);
    await Promise.resolve();
    expect(f.workflow.getSnapshot()).toEqual({ kind: 'idle' });
    expect(f.client.getSnapshot().completedRecording).toBeNull();
  });

  it('stops an in-flight native start when Stop arrives before Start resolves', async () => {
    const f = fixture();
    const start = deferred<Awaited<ReturnType<NativeRecordingControl['start']>>>();
    vi.mocked(f.control.start).mockReturnValue(start.promise);
    const opening = f.client.start('note_1', 'Meeting');
    await vi.waitFor(() => expect(f.control.start).toHaveBeenCalledOnce());
    await f.client.stop();
    start.resolve({ ok: true as const, recordingId: 'rec_1' });
    await opening;
    expect(f.control.stop).toHaveBeenCalledWith('rec_1');
    f.push({ ...capturing, status: 'idle' });
    await vi.waitFor(() => expect(f.workflow.getSnapshot()).toMatchObject({ kind: 'skill', recordingId: 'rec_1' }));
    expect(f.client.getSnapshot().completedRecording).toMatchObject({ recordingId: 'rec_1' });
  });

  it('detaches on renderer disposal without stopping native capture', () => {
    const f = fixture(capturing);
    f.client.dispose();
    expect(f.offNative).toHaveBeenCalledOnce();
    expect(f.offAuth).toHaveBeenCalledOnce();
    expect(f.control.stop).not.toHaveBeenCalled();
  });
});

it.each(['note_1', 'note_other'])('preserves a concurrent native capture on %s after a delayed busy response', async noteId => {
  const f = fixture();
  const result = deferred<Awaited<ReturnType<NativeRecordingControl['start']>>>();
  vi.mocked(f.control.start).mockReturnValueOnce(result.promise);
  const starting = f.client.start('note_1', 'Meeting');
  await vi.waitFor(() => expect(f.control.start).toHaveBeenCalled());
  await f.client.stop();
  f.push({ ...capturing, recordingId: 'rec_other', noteId });
  result.resolve({ ok: false, reason: 'busy' });
  await starting;
  expect(f.client.getSnapshot()).toMatchObject({ isRecording: true, recordingId: 'rec_other', noteId, error: null });
  expect(f.workflow.getSnapshot()).toMatchObject({ kind: 'recording', phase: 'capturing', recordingId: 'rec_other', noteId });
  expect(f.control.stop).not.toHaveBeenCalled();
});

it('adopts pending recovery after reload until main resolves completion', async () => {
  const f = fixture();
  const completion = deferred<boolean>();
  vi.mocked(f.control.claimCompletion).mockReturnValueOnce(completion.promise);
  f.push({ ...capturing, status: 'idle', finalizingRecordingIds: ['rec_1'] });
  expect(f.workflow.getSnapshot()).toMatchObject({ kind: 'recording', phase: 'finalizing' });
  expect(f.client.getSnapshot().isFinalizing).toBe(true);
  completion.resolve(false);
  await vi.waitFor(() => expect(f.workflow.getSnapshot()).toEqual({ kind: 'idle' }));
});
