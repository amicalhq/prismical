import {
  activeOrgIdOf,
  ensureAutoPausePolicy,
  getAutoEnhanceEnabled,
  nativeNotice,
  usageKey,
  type RecordingSessionClient,
  type RecordingSessionSnapshot,
  type Usage,
} from '@prismical/app-client';
import {
  ENHANCE_SKILL_ID,
  type AuthPort,
  type NativeRecordingControl,
  type NativeRecordingState,
} from '@prismical/app-contracts';
import type { RecordingWorkflow, WorkflowRuntime } from '@prismical/app-workflow';
import type { QueryClient } from '@tanstack/react-query';

interface Session {
  workflowId: string;
  noteId: string;
  recordingId?: string;
  ownerSessionKey: string;
  ownerOrgId: string;
  claiming?: Promise<void>;
  startingNative?: boolean;
  segments?: number;
}

const emptySnapshot = (): RecordingSessionSnapshot => ({
  state: 'idle', isRecording: false, isPaused: false, canPause: true,
  recordingId: null, noteId: null, completedRecording: null, isFinalizing: false,
  startedAt: null, nativeElapsed: null, liveSegments: [], error: null, errorUser: null,
  gracePrompt: null, pauseReason: null, autoStopRequested: false, micSilent: false,
  retryAvailable: false,
});

/** Native capture and durable finalization remain in main; the shared workflow owns UI admission. */
export function createNativeRecordingController(options: {
  auth: AuthPort;
  control: NativeRecordingControl;
  workflow: WorkflowRuntime;
}): RecordingSessionClient {
  const { auth, control, workflow } = options;
  const listeners = new Set<() => void>();
  let snapshot = emptySnapshot();
  let session: Session | undefined;
  let nativeState: NativeRecordingState | undefined;
  let queryClient: QueryClient | undefined;
  let skipAutoEnhanceForNote: string | undefined;
  let disconnect: (() => void) | undefined;
  let disposed = false;
  let hadAutoPausePrompt = false;

  function publish(patch: Partial<RecordingSessionSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  }
  function scope(s: Session): RecordingWorkflow | undefined {
    const current = workflow.getSnapshot();
    return current.kind === 'recording' && current.workflowId === s.workflowId ? current : undefined;
  }
  function owns(s: Session) {
    const view = auth.getSession();
    return !disposed && session === s &&
      (view.activeSessionKey ?? view.activeSub) === s.ownerSessionKey &&
      activeOrgIdOf(view) === s.ownerOrgId;
  }
  function fail(s: Session, error: RecordingSessionSnapshot['error']) {
    const current = scope(s);
    if (session === s) session = undefined;
    if (current) workflow.dispatch({ type: 'recordingFailed', ...current, captureClosed: true });
    publish({ error, autoStopRequested: false });
  }
  function admit(noteId: string, recordingId?: string): Session | undefined {
    const view = auth.getSession();
    const ownerSessionKey = view.activeSessionKey ?? view.activeSub;
    const ownerOrgId = activeOrgIdOf(view);
    if (!ownerSessionKey || !ownerOrgId) return;
    const s = { workflowId: crypto.randomUUID(), noteId, recordingId, ownerSessionKey, ownerOrgId };
    if (!workflow.dispatch({ type: 'startRecording', ...s }).accepted) return;
    session = s;
    hadAutoPausePrompt = false;
    publish({ ...emptySnapshot(), state: 'starting', noteId, recordingId: recordingId ?? null });
    return s;
  }
  function drained(s: Session) {
    let current = scope(s);
    if (!current) return;
    if (!['draining', 'finalizing'].includes(current.phase)) {
      workflow.dispatch({ type: 'stopRecording', workflowId: s.workflowId });
      current = scope(s);
    }
    if (current?.phase === 'draining') workflow.dispatch({ type: 'inputDrained', ...current });
  }
  function complete(s: Session, segments: number) {
    s.segments = Math.max(s.segments ?? 0, segments);
    if (s.claiming || !s.recordingId) return;
    drained(s);
    s.claiming = control.claimCompletion(s.recordingId).then(claimed => {
      if (!owns(s)) return;
      const current = scope(s);
      if (!current || current.phase !== 'finalizing') return;
      const autoSkill = claimed && getAutoEnhanceEnabled() && s.noteId !== skipAutoEnhanceForNote
        ? { skillId: ENHANCE_SKILL_ID } : undefined;
      session = undefined;
      if (claimed) publish({ completedRecording: {
        recordingId: s.recordingId!, noteId: s.noteId,
        segments: s.segments ?? 0,
        ownerSessionKey: s.ownerSessionKey, ownerOrgId: s.ownerOrgId,
        ...(autoSkill ? { workflowId: s.workflowId } : {}),
      } });
      workflow.dispatch({ type: 'finalizationSucceeded', ...current, recordingId: s.recordingId, autoSkill });
    }).catch(() => {
      if (owns(s)) fail(s, 'recording.errors.endedUnexpectedly');
    });
  }
  function receive(state: NativeRecordingState) {
    if (disposed) return;
    nativeState = state;
    const active = state.status !== 'idle' && state.status !== 'error';
    const completed = state.completedRecordings?.find(row => row.noteId !== null);
    const recordingId = active ? state.recordingId : completed?.recordingId ?? state.recordingId;
    const noteId = active ? state.noteId : completed?.noteId ?? state.noteId;
    // Main can advance while a renderer misses terminal pushes. Its new active ID
    // replaces the old projection, including its quota baseline and media clock.
    if (active && recordingId && session &&
      (session.noteId !== noteId || (session.recordingId && session.recordingId !== recordingId))) {
      fail(session, null);
    }
    // Replay adopts main's current capture or unclaimed completion after reload/navigation.
    if (!session && recordingId && noteId &&
      (active || completed || state.finalizingRecordingIds?.includes(recordingId))) {
      admit(noteId, recordingId);
    }
    const s = session;
    if (!s || !owns(s)) return;
    if (s.recordingId && s.recordingId !== state.recordingId) {
      const result = state.completedRecordings?.find(row => row.recordingId === s.recordingId);
      if (result) complete(s, result.segments);
      return;
    }
    if (state.recordingId) s.recordingId = state.recordingId;
    let current = scope(s);
    if (!current) return;
    if (s.recordingId && current.phase === 'starting' && state.status !== 'starting') {
      workflow.dispatch({ type: 'captureReady', ...current, recordingId: s.recordingId });
      current = scope(s)!;
    }
    if (state.status === 'paused' && current.phase === 'capturing') {
      if (!current.control) workflow.dispatch({ type: 'pauseRecording', workflowId: s.workflowId });
      const pausing = scope(s);
      if (pausing) workflow.dispatch({ type: 'capturePaused', ...pausing });
    } else if (state.status === 'recording' && current.phase === 'paused') {
      if (!current.control) workflow.dispatch({ type: 'resumeRecording', workflowId: s.workflowId });
      const resuming = scope(s);
      if (resuming) workflow.dispatch({ type: 'captureResumed', ...resuming });
    } else if (state.status === 'stopping' && !['draining', 'finalizing'].includes(current.phase)) {
      workflow.dispatch({ type: 'stopRecording', workflowId: s.workflowId });
    }
    publish({
      recordingId: s.recordingId ?? null,
      startedAt: state.startedAt == null ? null : new Date(state.startedAt).toISOString(),
      nativeElapsed: { status: state.status, elapsedMs: state.elapsedMs, elapsedAt: state.elapsedAt },
      liveSegments: [...state.segments], error: nativeNotice(state),
      pauseReason: state.status === 'paused'
        ? snapshot.pauseReason ?? (hadAutoPausePrompt ? 'silence' : 'user') : null,
      autoStopRequested: state.autoStopRequested ?? false,
    });
    // Main's notify window owns the prompt actions; the app only projects pause attribution.
    hadAutoPausePrompt = state.autoPausePrompt != null;
    if ((state.status === 'idle' || state.status === 'error') && s.recordingId) {
      const result = state.completedRecordings?.find(row => row.recordingId === s.recordingId);
      complete(s, result?.segments ?? state.segments.length);
    }
  }
  function project() {
    const current = workflow.getSnapshot();
    const phase = current.kind === 'recording' ? current.phase : 'idle';
    publish({
      state: phase === 'capturing' ? 'recording'
        : phase === 'draining' || phase === 'finalizing' ? 'stopping' : phase,
      isRecording: phase === 'capturing', isPaused: phase === 'paused',
      isFinalizing: phase === 'draining' || phase === 'finalizing',
    });
  }
  function connect() {
    if (disconnect || disposed) return;
    const offWorkflow = workflow.subscribe(project);
    const offAuth = auth.onSessionChanged(view => {
      if (view.state !== 'refreshing' && session && !owns(session)) {
        fail(session, null);
        publish(emptySnapshot());
      }
    });
    const offNative = control.subscribe(receive);
    disconnect = () => { offWorkflow(); offAuth(); offNative(); };
  }
  async function start(noteId: string, title: string) {
    connect();
    if (disposed || !queryClient) return;
    const s = admit(noteId);
    if (!s) return;
    try {
      const policy = await ensureAutoPausePolicy(queryClient, s.ownerOrgId);
      if (!owns(s) || scope(s)?.phase !== 'starting') return;
      const quota = queryClient.getQueryData<Usage>(usageKey(s.ownerOrgId))?.quota?.cloudTranscription;
      s.startingNative = true;
      const result = await control.start({
        noteId, title,
        quotaRemainingAtStartSeconds: quota?.limitSeconds == null ? null : Math.max(0, quota.limitSeconds - quota.usedSeconds),
        ...(policy.enabled ? { autoPause: {
          silenceSeconds: policy.silenceSeconds, graceSeconds: policy.graceSeconds,
          autoStopAfterPausedMinutes: policy.autoStopAfterPausedMinutes,
        } } : {}),
      });
      if (!owns(s)) return;
      // A concurrent native Start may publish its capture before our request is rejected.
      // Re-adopt that capture so the stale response cannot clear or stop its projection.
      if (nativeState && nativeState.status !== 'idle' && nativeState.status !== 'error' &&
        nativeState.recordingId && (!result.ok || nativeState.recordingId !== result.recordingId)) {
        const activeState = nativeState;
        fail(s, null);
        receive(activeState);
        return;
      }
      if (!result.ok) {
        fail(s, result.reason === 'permission-denied' ? 'recording.errors.microphoneDenied'
          : result.reason === 'busy' ? 'recording.errors.alreadyInProgress'
          : result.reason === 'model-missing' ? 'recording.errors.modelMissing'
          : result.reason === 'storage-unavailable' ? 'recording.errors.storageUnavailable'
          : result.reason === 'suggestion-pending' ? 'recording.actions.reviewBeforeRecording'
          : 'recording.errors.couldNotStart');
        return;
      }
      s.recordingId = result.recordingId;
      publish({ recordingId: result.recordingId });
      // Stop may arrive while the permission prompt/start IPC is still pending.
      if (scope(s)?.phase === 'draining') await control.stop(result.recordingId);
    } catch {
      if (owns(s)) fail(s, 'recording.errors.couldNotStart');
    }
  }
  async function changePause(paused: boolean) {
    const s = session;
    if (!s?.recordingId || !owns(s)) return false;
    const request = workflow.dispatch({ type: paused ? 'pauseRecording' : 'resumeRecording', workflowId: s.workflowId });
    if (!request.accepted) return false;
    const accepted = await (paused ? control.pause(s.recordingId) : control.resume(s.recordingId)).catch(() => false);
    if (owns(s) && request.state.kind === 'recording') {
      workflow.dispatch({ type: accepted ? paused ? 'capturePaused' : 'captureResumed' : 'captureControlFailed', ...request.state });
    }
    return accepted;
  }
  async function stop() {
    const s = session;
    if (!s || !owns(s)) return { segments: snapshot.liveSegments.length };
    if (!workflow.dispatch({ type: 'stopRecording', workflowId: s.workflowId }).accepted) {
      return { segments: snapshot.liveSegments.length };
    }
    if (s.recordingId) {
      try { await control.stop(s.recordingId); }
      catch { if (owns(s)) fail(s, 'recording.errors.endedUnexpectedly'); }
    } else if (!s.startingNative) {
      // Policy lookup has not opened native capture yet. Retire admission immediately.
      fail(s, null);
    }
    return { segments: snapshot.liveSegments.length };
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { connect(); listeners.add(listener); return () => { listeners.delete(listener); }; },
    start, pause: () => changePause(true), resume: () => changePause(false), stop,
    // Durable native jobs retry in main. There is no renderer-owned audio to abandon.
    retry: async () => {}, abandon: async () => {},
    clearError: () => publish({ error: null, errorUser: null }),
    keepRecording: () => {}, pauseFromPrompt: () => { void changePause(true); },
    configure(value) {
      skipAutoEnhanceForNote = value.skipAutoEnhanceForNote;
      if (value.queryClient) queryClient = value.queryClient;
    },
    dispose() {
      disposed = true;
      disconnect?.();
      disconnect = undefined;
      listeners.clear();
      // Closing a renderer must not stop main's capture or its durable recovery job.
    },
  };
}
