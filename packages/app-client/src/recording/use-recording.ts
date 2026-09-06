'use client';

import * as React from 'react';
import { ChunkBoundaryPicker } from './chunker';
import { encodeWavPcm16 } from './wav-encode';
import {
  abandonStaging,
  completeStaging,
  createRecording,
  finalizeRecording,
  getTranscriptionSettings,
  mintStagingUrls,
  type CoreTranscriptSegment,
} from '../api/transcription';
import {
  canPersistStagingRecovery,
  discardStagingBuffer,
  listPendingStagingRecoveries,
  readStagingBuffer,
  removePendingStagingRecovery,
  savePendingStagingRecovery,
  startStagingBuffer,
  sweepStagingBuffers,
  type PendingStagingRecovery,
  type StagingBuffer,
} from './staging-buffer';
import { AutoPauseMachine, SilenceWatcher, type AutoPauseEffect } from '@prismical/silence';
import { ensureAutoPausePolicy } from '../api/hooks/organizations';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthPort, NativeRecordingState, SessionView } from '@prismical/app-contracts';
import type { ApplicationTranslationKey } from '@prismical/app-i18n';
import { ApiError } from '../api/client';
import { EVENTS } from '../analytics-events';
import {
  transcriptKey,
  recordingsKey,
  noteRecordingsKey,
  enhancedRecordingsKey,
} from '../api/hooks/transcripts';
import { useAutoEnhanceStore } from '../notes/auto-enhance-store';
import { getAutoEnhanceEnabled } from './auto-enhance-setting';
import { aiUserErrorOf } from '../errors/ai-user-error';
import type { AiUserError } from '@prismical/api-contracts';
import { ensureModelDefault } from '../api/hooks/model-defaults';
import { activeOrgIdOf, usePorts } from '../ports-context';
import {
  DEFAULT_MICROPHONE_DEVICE_ID,
  getRecordingPreferences,
  resolveActiveMicrophone,
  transcriptionLanguageFor,
} from './recording-preferences';

const SAMPLE_RATE = 16000; // mirrors desktop useAudioCapture
const MAX_UPLOAD_ATTEMPTS = 3;
const MAX_ABANDON_ATTEMPTS = 3;
// Dead-mic detection: a capture stream whose samples are exactly
// zero is broken — most commonly macOS revoking the browser's mic permission (a Chrome
// update can wedge it), where getUserMedia still "succeeds" and the tab shows recording
// but CoreAudio delivers pure digital silence. A real mic in a dead-quiet room never
// reads 0 — its noise floor sits around 1e-3 — so exact zeros for several seconds can
// only be a dead stream (or a hardware-muted mic, which deserves the same warning).
const SILENT_MIC_PEAK = 1e-6;
const SILENT_MIC_SECONDS = 4;
// Chunks upload over N parallel lanes so warm-up's ~1s chunks (and managed round-trips)
// overlap instead of queueing; core serializes the DB writes per recording anyway.
const UPLOAD_CONCURRENCY = 3;
// Auto-pause never fires in the opening seconds of a session: pausing right
// after the user pressed record reads as "the button is broken", and the chunker's warm-up window
// is where cadence is least representative anyway.
const MIN_SESSION_SECONDS_BEFORE_AUTO_PAUSE = 30;
// How often the paused session checks the auto-stop deadline. Coarse on purpose — it is a
// 20-minute decision, and this timer only exists because no frames flow while paused.
const AUTO_STOP_POLL_MS = 5_000;
type RecordingErrorKey = ApplicationTranslationKey;

const DEFERRED_RECOVERY_ERROR: RecordingErrorKey = 'recording.errors.deferredRecovery';
const STAGING_BUFFER_CLOSE_GRACE_MS = 60_000;

class RecordingSessionChangedError extends Error {}

function exactSessionKey(view: SessionView): string | null {
  return view.activeSessionKey ?? view.activeSub ?? null;
}

function ownsSessionContext(view: SessionView, ownerSessionKey: string): boolean {
  return exactSessionKey(view) === ownerSessionKey;
}

function ownsActiveContext(auth: AuthPort, ownerSessionKey: string): boolean {
  return ownsSessionContext(auth.getSession(), ownerSessionKey);
}

async function boundAuthToken(auth: AuthPort, ownerSessionKey: string): Promise<string> {
  if (!ownsActiveContext(auth, ownerSessionKey)) {
    throw new RecordingSessionChangedError();
  }
  // Recordings intentionally survive an org-picker change and keep every wire
  // call pinned to ownerOrgId separately. Only a login-slot replacement is terminal.
  const token = await auth.getTokenForSession(ownerSessionKey);
  if (!token || !ownsActiveContext(auth, ownerSessionKey)) {
    throw new RecordingSessionChangedError();
  }
  return token;
}

const webAudioConstraints = (deviceId = ''): MediaTrackConstraints => ({
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
});

function selectedMicrophoneUnavailable(error: unknown): boolean {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : '';
  return name === 'NotFoundError' || name === 'OverconstrainedError';
}

async function resolveWebMicrophone(
  priority: ReturnType<typeof getRecordingPreferences>['microphonePriority']
): Promise<string> {
  if (!navigator.mediaDevices.enumerateDevices) return DEFAULT_MICROPHONE_DEVICE_ID;
  const connected = await navigator.mediaDevices
    .enumerateDevices()
    .then(devices => [
      {
        deviceId: DEFAULT_MICROPHONE_DEVICE_ID,
        label: DEFAULT_MICROPHONE_DEVICE_ID,
        isDefault: true,
      },
      ...devices
        .filter(device => device.kind === 'audioinput')
        .filter(
          device =>
            device.deviceId !== DEFAULT_MICROPHONE_DEVICE_ID && device.deviceId !== 'communications'
        )
        .map(device => ({ deviceId: device.deviceId, label: device.label })),
    ])
    .catch(() => [
      {
        deviceId: DEFAULT_MICROPHONE_DEVICE_ID,
        label: DEFAULT_MICROPHONE_DEVICE_ID,
        isDefault: true,
      },
    ]);
  return resolveActiveMicrophone(priority, connected);
}

async function openWebMicrophone(deviceId: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: webAudioConstraints(deviceId === DEFAULT_MICROPHONE_DEVICE_ID ? '' : deviceId),
    });
  } catch (error) {
    if (deviceId === DEFAULT_MICROPHONE_DEVICE_ID || !selectedMicrophoneUnavailable(error)) {
      throw error;
    }
    // Preserve reconnect semantics: fall back now, but keep the
    // preferred device in the chain so it can reclaim priority later.
    return navigator.mediaDevices.getUserMedia({ audio: webAudioConstraints() });
  }
}

/** Delay before retrying a failed live chunk, or null when the failure is permanent.
 * A quota/config 4xx fails identically and just delays the next chunks. */
function uploadRetryDelayMs(err: unknown, attempt: number): number | null {
  if (err instanceof ApiError) {
    if (err.status === 429) return 5000 * attempt; // the server window is 1 min — back off for real
    // 401 = mid-recording token expiry. The port's onUnauthorized() has already kicked the
    // refresh, and every attempt obtains a fresh token only if the exact owner slot is still
    // active. Dropping instead of retrying would lose the chunk's audio permanently.
    if (err.status === 401 || err.status === 408 || err.status >= 500) return 500 * attempt;
    return null; // other 4xx (402 quota, 422 config, …): the retry can't change the outcome
  }
  return 500 * attempt; // network hiccup / unknown: worth retrying
}

async function abandonStagingWithRetry(
  recordingId: string,
  reason: 'no-audio' | 'staging-disabled' | 'upload-failed',
  activeOrgId: string,
  auth: AuthPort,
  ownerSessionKey: string
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_ABANDON_ATTEMPTS; attempt++) {
    try {
      const authToken = await boundAuthToken(auth, ownerSessionKey);
      await abandonStaging(recordingId, reason, activeOrgId, authToken);
      return true;
    } catch (err) {
      if (err instanceof RecordingSessionChangedError) return false;
      const retryable =
        !(err instanceof ApiError) ||
        err.status === 401 ||
        err.status === 408 ||
        err.status === 429 ||
        err.status >= 500;
      if (!retryable || attempt === MAX_ABANDON_ATTEMPTS) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 410)) return true;
        console.warn('audio staging abandon failed; server readiness gate remains closed', err);
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
  return false;
}

export type RecState = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping';

// --- Native (desktop) recording bridge helpers ------------------------------
// Main's RecordingState.status carries an extra `error` terminal the shared
// RecState has no slot for; it collapses to idle (the mic button returns) with
// the failure surfaced through `error` below.
function nativeStatusToRecState(status: NativeRecordingState['status']): RecState {
  switch (status) {
    case 'starting':
      return 'starting';
    case 'recording':
      return 'recording';
    case 'paused':
      return 'paused';
    case 'stopping':
      return 'stopping';
    default:
      return 'idle'; // idle + error
  }
}

// The banner text a native state implies, or null. A capture give-up wins over
// a missing mic, which wins over a system/dual → mic degrade. Normal mic
// alignment transitions are silent.
const NATIVE_NOTICE_KEYS: ReadonlySet<RecordingErrorKey> = new Set<RecordingErrorKey>([
  'recording.errors.endedUnexpectedly',
  'recording.errors.noMicrophoneSystemAudioContinues',
  'recording.errors.noMicrophone',
  'recording.errors.systemAudioUnavailable',
]);

function nativeNotice(state: NativeRecordingState): RecordingErrorKey | null {
  if (state.status === 'error') return 'recording.errors.endedUnexpectedly';
  if (state.micSource === 'unavailable') {
    return state.captureMode === 'dual'
      ? 'recording.errors.noMicrophoneSystemAudioContinues'
      : 'recording.errors.noMicrophone';
  }
  if (
    state.requestedCaptureMode !== null &&
    state.captureMode !== null &&
    state.requestedCaptureMode !== state.captureMode
  ) {
    return 'recording.errors.systemAudioUnavailable';
  }
  return null;
}

interface RecordingSession {
  noteId: string;
  phase: RecState;
  stopPromise?: Promise<{ segments: number }>;
  ctx: AudioContext | null;
  stream: MediaStream | null;
  node: AudioWorkletNode | null;
  picker: ChunkBoundaryPicker | null;
  recordingId: string | null;
  chunkIndex: number;
  sentSamples: number;
  /** Round-robin upload lanes: each lane serializes, so ≤UPLOAD_CONCURRENCY in flight. */
  uploadLanes: Promise<void>[];
  /** Always-on session buffer for the finalize pass; null = can't buffer here. */
  staging: StagingBuffer | null;
  /** False = deferred mode: capture and buffer only, with zero chunk uploads — the
   * staged batch pass at stop produces the whole transcript. */
  liveLane: boolean;
  /** Identity frozen with the session so a later account/org switch cannot claim its recovery. */
  ownerSub: string;
  ownerOrgId: string;
  ownerSessionKey: string;
  /** Set before local teardown so queued async work cannot cross into a new login. */
  cancelled: boolean;
  stagingStopped: boolean;
  /** A user-fixable transcription failure (rejected key, quota) stopped the session's uploads:
   * every later chunk would fail the same way, so they are skipped instead of retried. The
   * recording itself continues (and is buffered for the finalize pass). */
  uploadsHalted: boolean;
}

/** Stop intents retain full-session audio until finalization and staging settle. */
type StagingAttempt =
  | { status: 'complete' }
  | { status: 'closed' }
  | { status: 'session-ended' }
  | { status: 'retry' }
  | {
      status: 'abandon';
      reason: 'staging-disabled' | 'upload-failed';
    };

const pendingMemoryBlobs = new Map<string, Blob>();
const pendingEphemeralRecoveries = new Map<string, PendingStagingRecovery>();
const activeStagingRecoveries = new Set<string>();

function rememberStagingRecovery(item: PendingStagingRecovery): void {
  if (savePendingStagingRecovery(item)) {
    pendingEphemeralRecoveries.delete(item.recordingId);
  } else {
    pendingEphemeralRecoveries.set(item.recordingId, item);
  }
}

function isRetryableStagingError(err: unknown): boolean {
  return (
    !(err instanceof ApiError) ||
    err.status === 0 ||
    err.status === 401 ||
    err.status === 408 ||
    err.status === 429 ||
    err.status >= 500
  );
}

async function attemptStagedUpload(
  recordingId: string,
  contentType: string,
  blob: Blob,
  durationMs: number,
  activeOrgId: string,
  auth: AuthPort,
  ownerSessionKey: string
): Promise<StagingAttempt> {
  const lane = { lane: 'mic' as const, contentType };
  let minted: Awaited<ReturnType<typeof mintStagingUrls>>;
  try {
    const authToken = await boundAuthToken(auth, ownerSessionKey);
    minted = await mintStagingUrls(recordingId, [lane], activeOrgId, authToken);
  } catch (err) {
    if (err instanceof RecordingSessionChangedError) return { status: 'session-ended' };
    if (err instanceof ApiError && err.status === 409) {
      return { status: 'abandon', reason: 'staging-disabled' };
    }
    console.warn('audio staging mint failed', err);
    return isRetryableStagingError(err)
      ? { status: 'retry' }
      : { status: 'abandon', reason: 'upload-failed' };
  }

  const upload = minted.uploads[0];
  if (!upload) return { status: 'retry' };
  try {
    await boundAuthToken(auth, ownerSessionKey);
    const put = await fetch(upload.url, {
      method: 'PUT',
      headers: upload.headers,
      body: blob,
    });
    if (!put.ok) {
      const failure = new ApiError(
        'STAGING_UPLOAD_FAILED',
        `Staging upload failed with status ${put.status}`,
        put.status
      );
      return isRetryableStagingError(failure)
        ? { status: 'retry' }
        : { status: 'abandon', reason: 'upload-failed' };
    }
    const authToken = await boundAuthToken(auth, ownerSessionKey);
    await completeStaging(
      recordingId,
      [{ ...lane, durationMs: Math.max(1, Math.round(durationMs)) }],
      activeOrgId,
      authToken
    );
    return { status: 'complete' };
  } catch (err) {
    if (err instanceof RecordingSessionChangedError) return { status: 'session-ended' };
    if (err instanceof ApiError && err.code === 'STAGING_FINALIZATION_CLOSED') {
      return { status: 'closed' };
    }
    console.warn('audio staging upload/complete failed', err);
    return isRetryableStagingError(err)
      ? { status: 'retry' }
      : { status: 'abandon', reason: 'upload-failed' };
  }
}

async function finishStagingRecovery(recordingId: string): Promise<void> {
  removePendingStagingRecovery(recordingId);
  pendingMemoryBlobs.delete(recordingId);
  pendingEphemeralRecoveries.delete(recordingId);
  await discardStagingBuffer(recordingId).catch(() => {});
}

function recordingRecoveryLock(recordingId: string): string {
  return `prismical-recording-recovery:${recordingId}`;
}

async function recoverPendingStaging(
  item: PendingStagingRecovery,
  auth: AuthPort,
  suppliedBlob?: Blob | null,
  onFinalized?: () => void
): Promise<boolean> {
  if (navigator.locks) {
    return navigator.locks.request(
      recordingRecoveryLock(item.recordingId),
      { ifAvailable: true },
      lock => (lock ? recoverPendingStagingLocked(item, auth, suppliedBlob, onFinalized) : false)
    );
  }
  return recoverPendingStagingLocked(item, auth, suppliedBlob, onFinalized);
}

async function recoverPendingStagingLocked(
  item: PendingStagingRecovery,
  auth: AuthPort,
  suppliedBlob?: Blob | null,
  onFinalized?: () => void
): Promise<boolean> {
  if (activeStagingRecoveries.has(item.recordingId)) return false;
  activeStagingRecoveries.add(item.recordingId);
  try {
    let current = item;
    if (current.needsFinalize) {
      try {
        const authToken = await boundAuthToken(auth, current.ownerSessionKey);
        await finalizeRecording(
          current.recordingId,
          current.durationMs,
          current.expectsStaging ?? true,
          current.transcriptionDeferred,
          {
            endedAt: current.endedAt,
            activeOrgId: current.ownerOrgId,
            authToken,
          }
        );
      } catch (err) {
        if (err instanceof RecordingSessionChangedError) return false;
        if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
          await finishStagingRecovery(current.recordingId);
          return true;
        }
        console.warn('recording finalize recovery failed', err);
        return false;
      }
      if (!ownsActiveContext(auth, current.ownerSessionKey)) return false;
      current = { ...current, needsFinalize: false };
      rememberStagingRecovery(current);
      onFinalized?.();
    }

    if (current.expectsStaging === false) {
      await finishStagingRecovery(current.recordingId);
      return true;
    }

    if (current.action === 'abandon') {
      const settled = await abandonStagingWithRetry(
        current.recordingId,
        current.abandonReason ?? 'upload-failed',
        current.ownerOrgId,
        auth,
        current.ownerSessionKey
      );
      if (settled) await finishStagingRecovery(current.recordingId);
      return settled;
    }

    // Explicit null comes from the originating MediaRecorder and means the buffer is known bad.
    // Undefined means a later recovery needs to reopen a previously finalized OPFS artifact.
    const suppliedBufferFailed = suppliedBlob === null;
    const memoryBlob =
      suppliedBlob === undefined ? pendingMemoryBlobs.get(current.recordingId) : suppliedBlob;
    // A ledger entry is written just before MediaRecorder closes. A new tab can observe it while
    // OPFS still exposes a partial snapshot; do not upload or abandon that snapshot during the
    // close grace. The originating tab supplies the completed Blob and bypasses this guard.
    if (
      !suppliedBufferFailed &&
      !memoryBlob &&
      Date.now() - current.createdAt < STAGING_BUFFER_CLOSE_GRACE_MS
    )
      return false;
    const blob = suppliedBufferFailed
      ? null
      : (memoryBlob ?? (await readStagingBuffer(current.recordingId, current.contentType)));
    if (!blob) {
      const abandonItem: PendingStagingRecovery = {
        ...current,
        action: 'abandon',
        abandonReason: 'no-audio',
      };
      rememberStagingRecovery(abandonItem);
      const settled = await abandonStagingWithRetry(
        current.recordingId,
        'no-audio',
        current.ownerOrgId,
        auth,
        current.ownerSessionKey
      );
      if (settled) await finishStagingRecovery(current.recordingId);
      return settled;
    }
    pendingMemoryBlobs.set(current.recordingId, blob);

    const outcome = await attemptStagedUpload(
      current.recordingId,
      current.contentType,
      blob,
      current.durationMs,
      current.ownerOrgId,
      auth,
      current.ownerSessionKey
    );
    if (outcome.status === 'complete' || outcome.status === 'closed') {
      await finishStagingRecovery(current.recordingId);
      return true;
    }
    if (outcome.status === 'retry') return false;
    if (outcome.status === 'session-ended') return false;

    const abandonItem: PendingStagingRecovery = {
      ...current,
      action: 'abandon',
      abandonReason: outcome.reason,
    };
    rememberStagingRecovery(abandonItem);
    const settled = await abandonStagingWithRetry(
      current.recordingId,
      outcome.reason,
      current.ownerOrgId,
      auth,
      current.ownerSessionKey
    );
    if (settled) await finishStagingRecovery(current.recordingId);
    return settled;
  } finally {
    activeStagingRecoveries.delete(item.recordingId);
  }
}

/** Why the session is paused — drives copy only; the pause itself is identical either way. */
export type PauseReason = 'user' | 'silence';

/** The live "Still there?" countdown. `deadlineMs`/`graceMs` are for the loader
 * animation only — the pause commits off the sample clock, so a throttled tab just animates
 * early and nothing happens until the audio actually says so. */
export interface GracePrompt {
  graceMs: number;
  deadlineMs: number;
}

export interface RecordingCompletion {
  recordingId: string;
  noteId: string;
  segments: number;
  ownerSessionKey: string;
  ownerOrgId: string;
}

export interface UseRecording {
  state: RecState;
  isRecording: boolean;
  isPaused: boolean;
  /** The capture stream is delivering pure digital silence (dead mic — usually the OS
   * blocking the browser's mic access while the recording UI looks live). Set once per
   * session after SILENT_MIC_SECONDS of exact-zero samples; the dock surfaces the fix. */
  micSilent: boolean;
  /** Pause/resume is available for this session's capture path. True on the web pipeline;
   * false while the desktop native pipeline drives recording, so the dock hides the pause button. */
  canPause: boolean;
  /** The active (or just-finished) recording id, for transcript queries. */
  recordingId: string | null;
  /** The immutable note owner, including while starting or after completion. */
  noteId: string | null;
  completedRecording: RecordingCompletion | null;
  /** When the active session started (ISO), anchoring the live lines' wall-clock times. */
  startedAt: string | null;
  /** Segments returned by chunk uploads during THIS session, in order. */
  liveSegments: CoreTranscriptSegment[];
  /** Mic permission / capture / upload-fatal error, for the dock to surface. */
  error: RecordingErrorKey | null;
  /** The server's own description of `error` when it came from core (a transcription failure it
   * classified: title, body and the recovery actions to offer, in the user's language). Null for
   * client-side causes - the dock then renders `error` from its catalog. */
  errorUser: AiUserError | null;
  /** Dismiss the surfaced error (the dock's banner/pill X). The error would
   * otherwise persist until the next start attempt. */
  clearError(): void;
  /** Non-null while the auto-pause countdown is running — the cluster renders it as a toast. */
  gracePrompt: GracePrompt | null;
  /** Why the current pause happened. Null unless paused. */
  pauseReason: PauseReason | null;
  /** The session has been paused long enough to auto-finalize. The caller routes this
   * request through stop(); completion effects are owned by this hook. */
  autoStopRequested: boolean;
  /** "Keep recording" — ANY interaction with the prompt except its Pause button routes here,
   * because touching it proves a human is present. Suppresses auto-pause for the rest of the
   * session rather than asking again in another two minutes. */
  keepRecording(): void;
  /** The prompt's explicit Pause button: a consented pause, attributed to the user. */
  pauseFromPrompt(): void;
  start(noteId: string, title: string): Promise<void>;
  /** Suspend capture without ending the session. Flushes the buffered partial chunk first, so
   * the transcript is complete up to the pause point; the session (recording row, chunk
   * counter, upload lanes, chunker warm-up) stays alive for resume(). Paused wall-time is
   * compressed out of the media timeline — no samples flow, so segment offsets and durationMs
   * simply continue where they left off. The server never learns about pause.
   * Resolves true iff the pause took effect — callers gate analytics on it. */
  pause(reason?: PauseReason): Promise<boolean>;
  /** Resume a paused session: un-suspend the AudioContext and keep counting. Resolves true
   * iff capture is flowing again (false: guard-rejected, dead mic track, or resume failure). */
  resume(): Promise<boolean>;
  /** Resolves after capture closes and finalization succeeds or is retained for retry.
   * `segments` is the number of transcript segments received during this session. */
  stop(): Promise<{ segments: number }>;
}

export function useRecording({
  handleCompletion = false,
}: { handleCompletion?: boolean } = {}): UseRecording {
  const [state, setState] = React.useState<RecState>('idle');
  const [recordingId, setRecordingId] = React.useState<string | null>(null);
  const [noteId, setNoteId] = React.useState<string | null>(null);
  const [completedRecording, setCompletedRecording] =
    React.useState<UseRecording['completedRecording']>(null);
  const openingRef = React.useRef<object | null>(null);
  const mountedRef = React.useRef(true);
  const [startedAt, setStartedAt] = React.useState<string | null>(null);
  const [liveSegments, setLiveSegments] = React.useState<CoreTranscriptSegment[]>([]);
  const [error, setError] = React.useState<RecordingErrorKey | null>(null);
  // The server-rendered block travels with the key it was set for: any other key (or null)
  // supersedes it, so a later client-side error never shows a stale server message.
  const [serverError, setServerError] = React.useState<{
    key: RecordingErrorKey;
    user: AiUserError;
  } | null>(null);
  const errorUser = serverError && serverError.key === error ? serverError.user : null;
  const clearError = React.useCallback(() => {
    setError(null);
    setServerError(null);
  }, []);
  // ---- Auto-pause on silence ----------------------------------------------------------------
  // The DECISION lives in @prismical/silence so desktop main runs the identical machine; this
  // hook only owns the wiring: feed it frames, apply its effects, render its prompt.
  const [gracePrompt, setGracePrompt] = React.useState<GracePrompt | null>(null);
  const [pauseReason, setPauseReason] = React.useState<PauseReason | null>(null);
  // The renderer handles this request through stop(), including native requests from main.
  const [autoStopRequested, setAutoStopRequested] = React.useState(false);
  const watcherRef = React.useRef<SilenceWatcher | null>(null);
  const machineRef = React.useRef<AutoPauseMachine | null>(null);
  /** Desktop only: the last prompt main pushed, for attributing the pause that follows it. */
  const nativePromptRef = React.useRef<GracePrompt | null>(null);
  /** Whether THIS session has auto-pause running at all (gate × deferred mode). */
  const autoPauseArmedRef = React.useRef(false);
  // The machine emits `pause`/`stop`; those callbacks are defined further down, so the frame
  // handler reaches them through a ref an effect keeps current (stale-closure safe, and render
  // stays pure for StrictMode / the React Compiler).
  const autoActionsRef = React.useRef<{ pause: (attributed: PauseReason) => void }>({
    pause: () => {},
  });
  // The user's Transcription default — resolved at recording create so every chunk uses that model
  // Omitted ⇒ managed Auto, whose engine is a server-side choice we don't name here.
  const qc = useQueryClient();
  // The raw WAV chunk upload rides the injected RecordingPort (web adapter does
  // the audio/wav POST; desktop never mounts this — its record button routes to
  // main's native pipeline).
  const { auth, recording, analytics } = usePorts();
  const finishRecording = React.useCallback(
    (finished: RecordingCompletion) => {
      // Completion remains owned even when the initiating renderer unmounts during its claim.
      void qc.invalidateQueries({ queryKey: transcriptKey(finished.recordingId) });
      void qc.invalidateQueries({ queryKey: recordingsKey(finished.noteId) });
      void qc.invalidateQueries({ queryKey: noteRecordingsKey(finished.noteId) });
      void qc.invalidateQueries({ queryKey: enhancedRecordingsKey(finished.noteId) });
      analytics.capture(EVENTS.RECORDING_COMPLETED, {
        note_id: finished.noteId,
        recording_id: finished.recordingId,
        segments: finished.segments,
      });
      if (getAutoEnhanceEnabled())
        useAutoEnhanceStore.getState().requestAutoEnhance({
          noteId: finished.noteId,
          recordingId: finished.recordingId,
          ownerSessionKey: finished.ownerSessionKey,
          ownerOrgId: finished.ownerOrgId,
          source: 'auto-enhance',
        });
      if (mountedRef.current) setCompletedRecording(finished);
    },
    [analytics, qc]
  );
  // Desktop only: when the port exposes native control, start/stop route
  // to main's RecordingService over IPC and the live segments arrive via the
  // pushed RecordingState below. Absent on web ⇒ the MediaRecorder path stays.
  const control = recording.control;

  // Mutable session internals (never re-render on these).
  const session = React.useRef<RecordingSession | null>(null);
  // Generation counter for pause's flush beat: resume()/stop() during the 150ms wait bump it,
  // and the pause continuation bails instead of suspending a context the UI already says is
  // live again (a plain double-click on the pause button lands in that window — without this,
  // the session went silent while the waveform kept animating).
  const pauseEpochRef = React.useRef(0);
  const [micSilent, setMicSilent] = React.useState(false);
  // Consecutive exact-zero samples seen; -1 once warned (stop re-checking this session).
  const silentRunRef = React.useRef(0);
  const detectSilentMic = React.useCallback((frame: Float32Array) => {
    if (silentRunRef.current < 0) return;
    let peak = 0;
    for (let i = 0; i < frame.length; i++) {
      const a = Math.abs(frame[i] ?? 0);
      if (a > peak) peak = a;
    }
    if (peak > SILENT_MIC_PEAK) {
      silentRunRef.current = 0;
      return;
    }
    silentRunRef.current += frame.length;
    if (silentRunRef.current >= SAMPLE_RATE * SILENT_MIC_SECONDS) {
      silentRunRef.current = -1;
      // No setError: the dock's red pill is too subtle for something this
      // actionable — the cluster surfaces micSilent as a toast with the fix link.
      setMicSilent(true);
    }
  }, []);
  // Segments produced this session, counted synchronously as chunks land (not derived from the
  // debounced React state) so stop() can report a race-free "had speech" signal. Reset on start.
  const segmentCountRef = React.useRef(0);
  const nativeOwnerRef = React.useRef<{
    recordingId: string;
    sessionKey: string | null;
    orgId: string | null;
  } | null>(null);

  // Native bridge (desktop): mirror main's pushed RecordingState into the SAME
  // dock/transcript state the web path drives, so the shared components can't
  // tell which capture produced the frames. No-op on web (no control). Main owns
  // the create/chunk/finalize lane; the renderer only reflects state here.
  React.useEffect(() => {
    if (!control) return;
    return control.subscribe(s => {
      if (s.recordingId !== nativeOwnerRef.current?.recordingId) {
        const view = auth.getSession();
        nativeOwnerRef.current = s.recordingId
          ? {
              recordingId: s.recordingId,
              sessionKey: exactSessionKey(view),
              orgId: activeOrgIdOf(view),
            }
          : null;
      }
      segmentCountRef.current = s.segments.length;
      const next = nativeStatusToRecState(s.status);
      // Desktop's card is rendered by main from its OWN state; this only decides the in-app copy.
      // A pause that lands while the prompt is up is ours — anything else is the user's. Tracking
      // the previous push is enough because main clears the prompt in the same transition that
      // sets 'paused', so by the time the paused state arrives the prompt is already gone.
      setPauseReason(prev => {
        if (next !== 'paused') return null;
        if (prev !== null) return prev;
        return nativePromptRef.current !== null ? 'silence' : 'user';
      });
      nativePromptRef.current = s.autoPausePrompt ?? null;
      setGracePrompt(s.autoPausePrompt ?? null);
      // Main asks; the cluster performs, through the same handler the stop button uses.
      setAutoStopRequested(s.autoStopRequested ?? false);
      setState(next);
      setRecordingId(s.recordingId);
      setNoteId(s.noteId);
      if (
        handleCompletion &&
        (s.status === 'idle' || s.status === 'error') &&
        s.recordingId &&
        s.noteId
      ) {
        const owner = nativeOwnerRef.current?.sessionKey;
        const ownerOrgId = nativeOwnerRef.current?.orgId;
        if (owner && ownerOrgId && ownsActiveContext(auth, owner)) {
          const finished = {
            recordingId: s.recordingId,
            noteId: s.noteId,
            segments: s.segments.length,
            ownerSessionKey: owner,
            ownerOrgId,
          };
          void control
            .claimCompletion(s.recordingId)
            .then(claimed => {
              if (claimed && exactSessionKey(auth.getSession()) === owner) {
                finishRecording(finished);
              }
            })
            .catch(() => {});
        }
      }
      setStartedAt(
        s.startedAt === null || s.startedAt === undefined
          ? null
          : new Date(s.startedAt).toISOString()
      );
      setLiveSegments([...s.segments]);
      // Main pushes state on every transition; only a notice main itself implies may replace
      // (or clear) the banner. An error set by this hook (a failed start's reason) must survive
      // the pushes that follow it, or it flashes for one frame and is gone.
      setError(prev => {
        const notice = nativeNotice(s);
        if (notice) return notice;
        return prev !== null && NATIVE_NOTICE_KEYS.has(prev) ? null : prev;
      });
    });
  }, [control, auth, handleCompletion, finishRecording]);

  // Warm the web start path once: the AudioWorklet module fetch and
  // the transcription model-default query both sit between the mic click and "recording" —
  // prefetching them at mount trims the "starting" window. What remains is one round trip
  // (createRecording, overlapped with the transcription-settings lookup) plus getUserMedia.
  // Desktop's native pipeline has neither, and failures here are fine (start() re-does both).
  React.useEffect(() => {
    if (control) return;
    void fetch('/audio-recorder-processor.js').catch(() => {});
    void ensureModelDefault(qc, 'transcription').catch(() => {});
  }, [control, qc]);

  // Retry owned finalization and upload intents on launch, reconnection, focus,
  // and while unresolved work remains in this session.
  React.useEffect(() => {
    if (control) return;
    let cancelled = false;
    let closeGraceTimer: number | null = null;
    const drain = async () => {
      if (closeGraceTimer !== null) {
        window.clearTimeout(closeGraceTimer);
        closeGraceTimer = null;
      }
      let unresolved = false;
      let nextCloseGraceMs: number | null = null;
      const view = auth.getSession();
      const activeSub = view.activeSub ?? null;
      const activeSessionKey = view.activeSessionKey ?? view.activeSub ?? null;
      const activeOrgId = activeOrgIdOf(view);
      const recoveries = new Map(
        listPendingStagingRecoveries().map(item => [item.recordingId, item])
      );
      for (const item of pendingEphemeralRecoveries.values()) {
        recoveries.set(item.recordingId, item);
      }
      for (const item of recoveries.values()) {
        if (cancelled) return;
        // Recovery credentials come from the active session. Leave another account/org's audio
        // untouched until its owner becomes active again.
        if (
          item.ownerSub !== activeSub ||
          item.ownerOrgId !== activeOrgId ||
          item.ownerSessionKey !== activeSessionKey
        )
          continue;
        const closeGraceRemaining = item.createdAt + STAGING_BUFFER_CLOSE_GRACE_MS - Date.now();
        if (item.action === 'upload' && closeGraceRemaining > 0) {
          nextCloseGraceMs =
            nextCloseGraceMs === null
              ? closeGraceRemaining
              : Math.min(nextCloseGraceMs, closeGraceRemaining);
        }
        if (
          !(await recoverPendingStaging(item, auth, undefined, () => {
            if (item.noteId)
              finishRecording({
                recordingId: item.recordingId,
                noteId: item.noteId,
                segments: 0,
                ownerSessionKey: item.ownerSessionKey,
                ownerOrgId: item.ownerOrgId,
              });
          }))
        )
          unresolved = true;
      }
      if (cancelled) return;
      setError(previous =>
        unresolved
          ? DEFERRED_RECOVERY_ERROR
          : previous === DEFERRED_RECOVERY_ERROR
            ? null
            : previous
      );
      if (unresolved) {
        closeGraceTimer = window.setTimeout(
          () => void drain(),
          Math.max(1, nextCloseGraceMs === null ? 5000 : nextCloseGraceMs + 50)
        );
      }
    };
    const resume = () => void drain();
    void drain();
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('recording-recovery-pending', resume);
    const unsubscribeSession = auth.onSessionChanged(resume);
    return () => {
      cancelled = true;
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
      window.removeEventListener('recording-recovery-pending', resume);
      unsubscribeSession();
      if (closeGraceTimer !== null) window.clearTimeout(closeGraceTimer);
    };
  }, [auth, control, finishRecording]);

  /**
   * Apply whatever the machine emitted. Deliberately the ONLY place effects are interpreted, so
   * web and desktop differ in rendering but never in meaning.
   */
  const applyAutoPauseEffects = React.useCallback(
    (effects: readonly AutoPauseEffect[] | undefined) => {
      if (!effects?.length) return;
      for (const effect of effects) {
        if (effect.kind === 'show-grace') {
          setGracePrompt({ graceMs: effect.graceMs, deadlineMs: effect.deadlineMs });
        } else if (effect.kind === 'hide-grace') {
          setGracePrompt(null);
        } else if (effect.kind === 'pause') {
          autoActionsRef.current.pause(effect.attributed);
        } else {
          setAutoStopRequested(true);
        }
      }
    },
    []
  );

  const teardownAudio = React.useCallback(() => {
    const s = session.current;
    if (!s) return;
    s.node?.port.close();
    s.node?.disconnect();
    s.stream?.getTracks().forEach(t => t.stop());
    void s.ctx?.close().catch(() => {});
    s.ctx = null;
    s.stream = null;
    s.node = null;
  }, []);

  // A recording belongs to an exact login slot, not merely a user + org. Stop
  // all local work when that slot changes so a same-sub ordinary session can
  // never inherit support-origin capture, retries, or staged recovery.
  React.useEffect(() => {
    if (control) return;
    return auth.onSessionChanged(view => {
      const s = session.current;
      if (!s || ownsSessionContext(view, s.ownerSessionKey)) return;
      s.cancelled = true;
      pauseEpochRef.current += 1;
      let stagedBlob: Promise<Blob | null> | null = null;
      if (s.staging && !s.stagingStopped) {
        s.stagingStopped = true;
        stagedBlob = s.staging.stop();
      }
      teardownAudio();
      session.current = null;
      if (s.recordingId) void finishStagingRecovery(s.recordingId);
      if (stagedBlob && s.staging) {
        void stagedBlob.finally(() => s.staging?.discard()).catch(() => {});
      } else {
        void s.staging?.discard().catch(() => {});
      }
      setState('idle');
      setRecordingId(null);
      setNoteId(null);
      setCompletedRecording(null);
      setStartedAt(null);
      setLiveSegments([]);
      setGracePrompt(null);
      setPauseReason(null);
      setAutoStopRequested(false);
      setError('recording.errors.endedUnexpectedly');
      applyAutoPauseEffects(machineRef.current?.noteStopped());
    });
  }, [auth, control, teardownAudio, applyAutoPauseEffects]);

  /** Bounded-parallel chunk uploads with status-aware retry; failures surface but don't kill
   * the session. Retrying the same chunkIndex is idempotent server-side, and lanes completing
   * out of order is fine — the live view re-sorts by segmentOrder. */
  const enqueueChunk = React.useCallback(
    (samples: Float32Array) => {
      const s = session.current;
      if (!s?.recordingId || samples.length === 0) return;
      if (s.uploadsHalted) {
        s.sentSamples += samples.length; // durationMs still derives from the samples captured
        return;
      }
      const chunkIndex = s.chunkIndex++;
      const chunkStartMs = (s.sentSamples / SAMPLE_RATE) * 1000;
      s.sentSamples += samples.length;
      const wav = encodeWavPcm16(samples, SAMPLE_RATE);
      const recId = s.recordingId;

      const upload = async () => {
        for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
          if (s.cancelled) return;
          try {
            const authToken = await boundAuthToken(auth, s.ownerSessionKey);
            const segs = await recording.uploadTranscriptionChunk(recId, wav, {
              chunkIndex,
              chunkStartMs,
              authToken,
              activeOrgId: s.ownerOrgId,
            });
            if (s.cancelled || !ownsActiveContext(auth, s.ownerSessionKey)) return;
            if (segs.length) {
              // The ASR heard words in this chunk (the two-signal rule): a
              // production model on the real audio outranks our energy gate, so cancel any
              // countdown even if the levels still read as silence. This is what makes it safe to
              // sit at a 100s threshold without ever pausing a quiet speaker.
              watcherRef.current?.noteTranscribedSpeech();
              applyAutoPauseEffects(machineRef.current?.speechTranscribed());
              segmentCountRef.current += segs.length;
              setLiveSegments(prev =>
                [...prev, ...segs].sort(
                  (a, b) => a.startTimeMs - b.startTimeMs || a.segmentOrder - b.segmentOrder
                )
              );
            }
            return;
          } catch (err) {
            if (err instanceof RecordingSessionChangedError || s.cancelled) return;
            const delay = attempt < MAX_UPLOAD_ATTEMPTS ? uploadRetryDelayMs(err, attempt) : null;
            if (delay === null) {
              // One gap is better than a dead session — warn and carry on.
              console.warn(`transcription chunk ${chunkIndex} failed`, err);
              const key: RecordingErrorKey =
                err instanceof ApiError && err.code === 'TRANSCRIPTION_QUOTA_EXCEEDED'
                  ? 'recording.errors.quotaExceeded'
                  : 'recording.errors.someAudioNotTranscribed';
              // Core describes the cause when it classified one (rejected key, out of credit,
              // retired model, quota): the dock shows that instead of the generic line. A cause
              // the retry policy already calls permanent (a config/quota/key 4xx, not a 401/408/
              // 429 that merely ran out of attempts) fails identically for every later chunk, so
              // stop uploading for the rest of the session instead of spending three attempts
              // each. The recording itself continues.
              const user = aiUserErrorOf(err);
              if (uploadRetryDelayMs(err, 1) === null) s.uploadsHalted = true;
              setServerError(user ? { key, user } : null);
              setError(key);
              return;
            }
            await new Promise(r => setTimeout(r, delay));
          }
        }
      };

      const lane = chunkIndex % s.uploadLanes.length;
      s.uploadLanes[lane] = (s.uploadLanes[lane] ?? Promise.resolve()).then(upload);
    },
    [recording, applyAutoPauseEffects, auth]
  );

  const start = React.useCallback(
    async (noteId: string, title: string) => {
      // Desktop: route to main's native pipeline (no getUserMedia, no chunk
      // upload). The recording → live-segments transitions arrive via the state
      // push above; here we only reflect start intent + a failed start's reason.
      if (control) {
        if (state !== 'idle') return;
        setError(null);
        setState('starting');
        setLiveSegments([]);
        segmentCountRef.current = 0;
        // Desktop runs the same machine in main — it only needs the policy.
        const policy = await ensureAutoPausePolicy(qc, activeOrgIdOf(auth.getSession()));
        const result = await control.start({
          noteId,
          title,
          ...(policy.enabled
            ? {
                autoPause: {
                  silenceSeconds: policy.silenceSeconds,
                  graceSeconds: policy.graceSeconds,
                  autoStopAfterPausedMinutes: policy.autoStopAfterPausedMinutes,
                },
              }
            : {}),
        });
        if (!result.ok) {
          setState('idle');
          setError(
            result.reason === 'permission-denied'
              ? 'recording.errors.microphoneDenied'
              : result.reason === 'busy'
                ? 'recording.errors.alreadyInProgress'
                : result.reason === 'model-missing'
                  ? 'recording.errors.modelMissing'
                  : result.reason === 'storage-unavailable'
                    ? 'recording.errors.storageUnavailable'
                    : 'recording.errors.couldNotStart'
          );
          return;
        }
        setRecordingId(result.recordingId);
        return;
      }
      if (session.current || openingRef.current || !mountedRef.current) return;
      const opening = {};
      openingRef.current = opening;
      const assertOpening = () => {
        if (openingRef.current !== opening || !mountedRef.current)
          throw new RecordingSessionChangedError();
      };
      setNoteId(noteId);
      setCompletedRecording(null);
      setError(null);
      setMicSilent(false);
      silentRunRef.current = 0;
      setState('starting');
      let openingStream: MediaStream | null = null;
      let openingContext: AudioContext | null = null;
      let openingNode: AudioWorkletNode | null = null;
      let openingStaging: StagingBuffer | null = null;
      try {
        const ownerView = auth.getSession();
        const ownerSub = ownerView.activeSub;
        const ownerSessionKey = ownerView.activeSessionKey ?? ownerSub;
        const ownerOrgId = activeOrgIdOf(ownerView);
        if (!ownerSub || !ownerSessionKey || !ownerOrgId) {
          throw new Error('No active recording owner');
        }
        let authToken = await boundAuthToken(auth, ownerSessionKey);
        // Resolve the Transcription default (loads it if the query hasn't settled) before create —
        // the recording's model is frozen here, so a BYOK choice must not be silently dropped.
        const modelParams = await ensureModelDefault(qc, 'transcription', {
          activeOrgId: ownerOrgId,
          authToken,
        });
        // Deferred mode: when the org has live transcription off, capture and
        // buffer only — zero chunk uploads; the staged batch pass at stop is the transcript.
        // Unreachable settings default to live (today's behavior). BYOK recordings FORCE the
        // live lane: the deferred drain only runs managed engines, and the user's pinned
        // provider must transcribe their audio — deferred would leave the recording empty.
        const byokChosen = Boolean((modelParams as { instanceId?: string }).instanceId);
        const preferences = getRecordingPreferences();
        authToken = await boundAuthToken(auth, ownerSessionKey);
        // Two INDEPENDENT round trips: the settings lookup does not feed createRecording (its
        // result is only read later, as effectiveLiveLane). Awaiting them one after the other put
        // two full server latencies between the click and the microphone opening, so overlap them.
        // Neither holds an OS resource, so a rejection here needs no teardown beyond the existing
        // catch — unlike the microphone, which is deliberately still opened afterwards.
        const [liveLane, rec] = await Promise.all([
          byokChosen
            ? Promise.resolve(true)
            : getTranscriptionSettings({ activeOrgId: ownerOrgId, authToken })
                .then(s => s.liveTranscription)
                .catch(() => true),
          createRecording(
            {
              noteId,
              title,
              ...modelParams,
              language: transcriptionLanguageFor(preferences),
            },
            { activeOrgId: ownerOrgId, authToken }
          ),
        ]);
        assertOpening();
        openingStream = await openWebMicrophone(
          await resolveWebMicrophone(preferences.microphonePriority)
        );
        assertOpening();
        // A mic that goes away mid-session (unplugged, Bluetooth off, OS revocation) ends its
        // track; the worklet then feeds silence forever. Name the cause and end the session so
        // what was captured is kept, instead of a silent recording nobody knows is silent.
        // The listener is attached now but the session only exists further down: an `ended`
        // that fires during the awaits in between is latched and honoured once the session is up.
        let micEndedDuringOpen = false;
        const onMicEnded = () => {
          const live = session.current;
          if (!live || live.stream !== openingStream) {
            micEndedDuringOpen = true;
            return;
          }
          if (live.cancelled) return;
          setError('recording.errors.microphoneDisconnected');
          void stopRef.current();
        };
        for (const track of openingStream.getTracks()) {
          if (typeof track.addEventListener !== 'function') continue;
          track.addEventListener('ended', onMicEnded);
        }
        await boundAuthToken(auth, ownerSessionKey);
        openingContext = new AudioContext({ sampleRate: SAMPLE_RATE });
        await openingContext.audioWorklet.addModule('/audio-recorder-processor.js');
        assertOpening();
        await boundAuthToken(auth, ownerSessionKey);
        const source = openingContext.createMediaStreamSource(openingStream);
        openingNode = new AudioWorkletNode(openingContext, 'audio-recorder-processor');
        source.connect(openingNode);
        openingStaging = await startStagingBuffer(openingStream, rec.id);
        assertOpening();
        // Deferred mode is only safe when BOTH artifacts survive a reload: full audio in OPFS and
        // its recovery intent in localStorage. Memory fallback remains useful for live-mode
        // diarization, but it must never be the sole transcript source.
        const deferredDurable =
          openingStaging?.durable === true &&
          canPersistStagingRecovery(ownerSessionKey !== ownerSub);
        const effectiveLiveLane = liveLane || !deferredDurable;

        // Auto-pause is per-session: a fresh watcher (so the previous room's noise floor doesn't
        // carry over) and a fresh machine (so last session's suppression doesn't either). The
        // policy is read HERE, at start, rather than per frame — a flag flipped mid-recording must
        // not change the rules under a session already in flight.
        // Non-reactive read: useRecording must not SUBSCRIBE to the session store just to learn
        // which org's policy applies — it needs the answer once, here, and this hook re-renders
        // on every state transition of the hottest path in the app.
        authToken = await boundAuthToken(auth, ownerSessionKey);
        const policy = await ensureAutoPausePolicy(qc, ownerOrgId, authToken);
        await boundAuthToken(auth, ownerSessionKey);
        assertOpening();
        watcherRef.current = new SilenceWatcher();
        machineRef.current = new AutoPauseMachine({
          // Deferred mode is excluded deliberately: it uploads no chunks,
          // so the ASR never returns text and the two-signal rule collapses to the bare energy
          // gate — and it also meters nothing, so there is no quota being burned to justify
          // running on one signal. Both halves of the rationale point the same way.
          enabled: policy.enabled && effectiveLiveLane,
          silenceSeconds: policy.silenceSeconds,
          graceSeconds: policy.graceSeconds,
          autoStopAfterPausedMinutes: policy.autoStopAfterPausedMinutes,
          minSessionSeconds: MIN_SESSION_SECONDS_BEFORE_AUTO_PAUSE,
        });
        autoPauseArmedRef.current = policy.enabled && effectiveLiveLane;
        setGracePrompt(null);
        setPauseReason(null);
        setAutoStopRequested(false);

        // Hygiene first (crashed sessions leave OPFS artifacts), then buffer this session.
        void sweepStagingBuffers(rec.id);
        session.current = {
          noteId,
          phase: 'recording',
          ctx: openingContext,
          stream: openingStream,
          node: openingNode,
          picker: new ChunkBoundaryPicker(SAMPLE_RATE),
          recordingId: rec.id,
          chunkIndex: 0,
          sentSamples: 0,
          uploadLanes: Array.from({ length: UPLOAD_CONCURRENCY }, () => Promise.resolve()),
          staging: openingStaging,
          liveLane: effectiveLiveLane,
          ownerSub,
          ownerOrgId,
          ownerSessionKey,
          cancelled: false,
          stagingStopped: false,
          uploadsHalted: false,
        };
        const activeSession = session.current;
        openingNode.port.onmessage = (ev: MessageEvent) => {
          if (
            ev.data?.type !== 'audioFrame' ||
            session.current !== activeSession ||
            activeSession.cancelled
          )
            return;
          const frame = ev.data.frame as Float32Array;
          detectSilentMic(frame);
          const s = session.current;
          if (!s) return;
          // Auto-pause. Inert in deferred mode — the machine is constructed disabled
          // there, see start().
          const watcher = watcherRef.current;
          const machine = machineRef.current;
          if (watcher && machine) {
            const silentSeconds = watcher.push(frame, SAMPLE_RATE);
            applyAutoPauseEffects(
              machine.observe({
                silentSeconds,
                elapsedSeconds: watcher.elapsedSeconds,
                nowMs: Date.now(),
              })
            );
          }
          if (!s.liveLane) {
            // Deferred: the worklet still runs for dead-mic detection + the sample count that
            // durationMs derives from — but nothing is chunked or uploaded.
            s.sentSamples += frame.length;
            return;
          }
          const chunk = s.picker?.push(frame);
          if (chunk) enqueueChunk(chunk);
        };

        setRecordingId(rec.id);
        // The server echoes the startedAt we sent; fall back to now if it ever comes back empty, so
        // live lines still get a clock time.
        setStartedAt(rec.startedAt ?? new Date().toISOString());
        setLiveSegments([]);
        segmentCountRef.current = 0;
        setState('recording');
        if (
          micEndedDuringOpen ||
          openingStream.getTracks().some(track => track.readyState === 'ended')
        ) {
          onMicEnded();
        }
      } catch (err) {
        openingNode?.port.close();
        openingNode?.disconnect();
        openingStream?.getTracks().forEach(track => track.stop());
        void openingContext?.close().catch(() => {});
        if (openingStaging) {
          void openingStaging
            .stop()
            .finally(() => openingStaging?.discard())
            .catch(() => {});
        }
        if (openingRef.current !== opening || !mountedRef.current) return;
        setState('idle');
        setError(
          err instanceof RecordingSessionChangedError
            ? 'recording.errors.couldNotStart'
            : err instanceof DOMException &&
                (err.name === 'NotAllowedError' || err.name === 'SecurityError')
              ? 'recording.errors.microphoneDenied'
              : 'recording.errors.couldNotStart'
        );
      } finally {
        if (openingRef.current === opening) openingRef.current = null;
      }
    },
    [control, state, enqueueChunk, detectSilentMic, qc, auth, applyAutoPauseEffects]
  );

  // Pause = flush, then suspend. The worklet drains its sub-frame remainder and the picker's
  // partial chunk uploads (same choreography as stop), so the transcript is complete at the
  // pause point; then the context suspends and no more frames flow. The mic track stays live
  // (the OS indicator stays on, like Zoom/Voice Memos) — tearing it down would mean a fresh
  // getUserMedia on resume. Session internals are untouched, so resume continues the same
  // chunkIndex/sentSamples and the chunker doesn't re-run its warm-up burst.
  const pause = React.useCallback(
    async (reason: PauseReason = 'user'): Promise<boolean> => {
      const s = session.current;
      if (control) {
        if (recordingId === null || state !== 'recording') return false;
        return control.pause(recordingId);
      }
      if (!s || s.phase !== 'recording') {
        // The machine asked for a pause we can't perform (already stopping, session gone). Tell it,
        // or it sits in 'committing' forever and auto-pause is silently dead for the session.
        if (reason === 'silence') machineRef.current?.notePauseFailed();
        return false;
      }
      const epoch = ++pauseEpochRef.current;
      setPauseReason(reason);
      s.phase = 'paused';
      setState('paused'); // freeze the UI on the click, not after the flush settles
      s.node?.port.postMessage({ type: 'flush' });
      // Same beat stop() gives the final worklet frame to arrive before draining the picker.
      await new Promise(r => setTimeout(r, 150));
      // resume()/stop() landed during the beat ⇒ this pause is void. Leave the picker
      // buffering (the frames kept flowing) and above all do NOT suspend — the UI already
      // says the session is live/stopping again. The pause itself DID happen, so report true.
      if (pauseEpochRef.current !== epoch) {
        // resume()/stop() won the race. The pause DID happen, but the machine must not think it is
        // sitting in a paused session — resume()/stop() have already told it where we actually are.
        return true;
      }
      const rest = s.liveLane ? s.picker?.flush() : undefined;
      if (rest) enqueueChunk(rest);
      s.staging?.pause(); // keep the staged timeline pause-compressed like the live one
      try {
        await s.ctx?.suspend();
      } catch {
        if (pauseEpochRef.current === epoch) {
          // The context refused to suspend ⇒ frames are still flowing. Never leave capture
          // running under a "Paused" UI — revert and say so.
          s.staging?.resume();
          s.phase = 'recording';
          setState('recording');
          setPauseReason(null);
          setError('recording.errors.couldNotPause');
          machineRef.current?.notePauseFailed();
          return false;
        }
      }
      // Re-check the epoch: resume()/stop() may have landed while `suspend()` was in flight (a real
      // AudioContext resolves it on the audio thread). Without this, a Resume clicked during that
      // window leaves the machine in 'paused' while capture is live — auto-pause and auto-stop both
      // dead for the rest of a running session — or, across a stop→start, lands on the NEXT
      // session's machine and kills that one instead.
      if (pauseEpochRef.current !== epoch) return true;
      // Confirmed paused. Starts the auto-stop clock — for a USER pause too, because a session
      // someone paused and then abandoned deserves finalizing into a real note just as much as one
      // we paused ourselves.
      applyAutoPauseEffects(machineRef.current?.notePaused(Date.now()));
      return true;
    },
    [control, recordingId, state, enqueueChunk, applyAutoPauseEffects]
  );

  const resume = React.useCallback(async (): Promise<boolean> => {
    const s = session.current;
    if (control) {
      if (recordingId === null || state !== 'paused') return false;
      return control.resume(recordingId);
    }
    if (!s || s.phase !== 'paused') return false;
    const epoch = ++pauseEpochRef.current; // void any pause continuation still in its flush beat
    // A long pause outlives mics: sleep, a Bluetooth headset powering off, or OS-level
    // revocation ends the track, and resuming the context would record silence.
    if (s.stream?.getTracks().some(t => t.readyState === 'ended')) {
      setError('recording.errors.microphoneDisconnected');
      return false;
    }
    try {
      await s.ctx?.resume();
      if (session.current !== s || s.cancelled || pauseEpochRef.current !== epoch) return false;
      s.staging?.resume();
      s.phase = 'recording';
      setError(null); // don't let a stale "could not resume" outlive a successful retry
      setPauseReason(null);
      setState('recording');
      // Back to listening, and the silence counter restarts from zero — otherwise the frames that
      // arrive immediately after a resume would still carry the pre-pause silent run and could
      // re-trip the threshold within seconds of the user coming back.
      watcherRef.current?.noteTranscribedSpeech();
      machineRef.current?.noteResumed();
      return true;
    } catch {
      if (session.current !== s || s.cancelled || pauseEpochRef.current !== epoch) return false;
      // Stay paused: the session is intact, so the user can retry (or stop and keep
      // everything captured so far).
      setError('recording.errors.couldNotResume');
      return false;
    }
  }, [control, recordingId, state]);

  const stop = React.useCallback(async (): Promise<{ segments: number }> => {
    // Desktop: ask main to stop + finalize. It resolves after finalize, by which
    // point the last segments have been pushed; segmentCountRef tracks them.
    if (control) {
      const id = recordingId;
      if (id === null || (state !== 'starting' && state !== 'recording' && state !== 'paused'))
        return { segments: segmentCountRef.current };
      setState('stopping');
      await control.stop(id);
      return { segments: segmentCountRef.current };
    }
    const s = session.current;
    if (!s) {
      if (openingRef.current) {
        openingRef.current = null;
        setState('idle');
      }
      return { segments: segmentCountRef.current };
    }
    if (s.stopPromise) return s.stopPromise;
    if (s.phase !== 'recording' && s.phase !== 'paused')
      return { segments: segmentCountRef.current };
    pauseEpochRef.current++;
    s.phase = 'stopping';
    setState('stopping');
    let pendingUpload: { item: PendingStagingRecovery; blob: Blob | null } | null = null;
    let retryAfterStop = false;
    const stopOwnedSession = async () => {
      let recoveryItem: PendingStagingRecovery | null = null;
      let stagedBlob: Promise<Blob | null> = Promise.resolve(null);
      try {
        s.node?.port.postMessage({ type: 'flush' });
        await new Promise(resolve => setTimeout(resolve, 150));
        if (s.cancelled || !ownsActiveContext(auth, s.ownerSessionKey))
          throw new RecordingSessionChangedError();
        const rest = s.liveLane ? s.picker?.flush() : undefined;
        if (rest) enqueueChunk(rest);
        const durationMs = (s.sentSamples / SAMPLE_RATE) * 1000;
        const endedAt = Date.now();
        s.stagingStopped = true;
        stagedBlob = s.staging?.stop() ?? Promise.resolve(null);
        teardownAudio();
        if (!s.recordingId) return { segments: segmentCountRef.current };

        const intent: PendingStagingRecovery = {
          version: 2,
          recordingId: s.recordingId,
          noteId: s.noteId,
          contentType: s.staging?.contentType ?? 'audio/webm',
          durationMs,
          endedAt,
          createdAt: Date.now(),
          ownerSub: s.ownerSub,
          ownerOrgId: s.ownerOrgId,
          ownerSessionKey: s.ownerSessionKey,
          transcriptionDeferred: !s.liveLane,
          expectsStaging: s.staging !== null,
          needsFinalize: true,
          action: 'upload',
        };
        const persistIntent = (): PendingStagingRecovery => {
          const persisted = savePendingStagingRecovery(intent);
          const item = persisted ? intent : { ...intent, transcriptionDeferred: false };
          if (!persisted) rememberStagingRecovery(item);
          return item;
        };
        activeStagingRecoveries.add(intent.recordingId);
        // The lock prevents another tab from finalizing while our chunk uploads drain.
        // Without Web Locks, publish only after draining; mid-drain reload recovery is unavailable.
        if (navigator.locks) recoveryItem = persistIntent();
        // Keep the close result even if finalize fails: memory fallback can retry in this page.
        void stagedBlob
          .then(blob => {
            if (blob && !s.cancelled) pendingMemoryBlobs.set(intent.recordingId, blob);
          })
          .catch(() => {});
        await Promise.all(s.uploadLanes);
        recoveryItem ??= persistIntent();
        if (s.cancelled || !ownsActiveContext(auth, s.ownerSessionKey))
          throw new RecordingSessionChangedError();
        const authToken = await boundAuthToken(auth, s.ownerSessionKey);
        await finalizeRecording(
          intent.recordingId,
          durationMs,
          intent.expectsStaging ?? true,
          recoveryItem.transcriptionDeferred,
          {
            endedAt,
            activeOrgId: s.ownerOrgId,
            authToken,
          }
        );
        if (s.cancelled || !ownsActiveContext(auth, s.ownerSessionKey))
          throw new RecordingSessionChangedError();
        recoveryItem = { ...recoveryItem, needsFinalize: false };
        rememberStagingRecovery(recoveryItem);
        finishRecording({
          recordingId: intent.recordingId,
          noteId: s.noteId,
          segments: segmentCountRef.current,
          ownerSessionKey: s.ownerSessionKey,
          ownerOrgId: s.ownerOrgId,
        });
        // Commit the local audio before releasing the cross-tab lock. The large network upload
        // remains separate from the stop result.
        pendingUpload = { item: recoveryItem, blob: await stagedBlob.catch(() => null) };
      } catch (err) {
        await stagedBlob.catch(() => null);
        if (s.recordingId) activeStagingRecoveries.delete(s.recordingId);
        if (err instanceof RecordingSessionChangedError || s.cancelled) {
          if (s.recordingId) await finishStagingRecovery(s.recordingId);
          void s.staging?.discard().catch(() => {});
        } else {
          console.warn('finalize recording failed', err);
          setError(recoveryItem ? DEFERRED_RECOVERY_ERROR : 'recording.errors.savedWithErrors');
          retryAfterStop = recoveryItem !== null;
        }
      } finally {
        if (session.current === s) {
          teardownAudio();
          session.current = null;
          setState('idle');
          setGracePrompt(null);
          setPauseReason(null);
          setAutoStopRequested(false);
          applyAutoPauseEffects(machineRef.current?.noteStopped());
        }
      }
      return { segments: segmentCountRef.current };
    };
    const stopping =
      navigator.locks && s.recordingId
        ? navigator.locks.request(recordingRecoveryLock(s.recordingId), stopOwnedSession)
        : stopOwnedSession();
    s.stopPromise = stopping.then(result => {
      if (retryAfterStop) window.dispatchEvent(new Event('recording-recovery-pending'));
      const pending = pendingUpload;
      if (pending) {
        activeStagingRecoveries.delete(pending.item.recordingId);
        void recoverPendingStaging(pending.item, auth, pending.blob).then(settled => {
          if (!settled && ownsActiveContext(auth, s.ownerSessionKey)) {
            if (mountedRef.current) setError(DEFERRED_RECOVERY_ERROR);
            window.dispatchEvent(new Event('recording-recovery-pending'));
          }
        });
      }
      return result;
    });
    return s.stopPromise;
  }, [
    control,
    recordingId,
    state,
    enqueueChunk,
    teardownAudio,
    applyAutoPauseEffects,
    auth,
    finishRecording,
  ]);

  // `stop` for callbacks registered before it exists (the mic track's `ended` listener). Kept
  // current from an effect, not during render, like the machine-effect ref below.
  const stopRef = React.useRef(stop);
  React.useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  // The machine's `pause`/`stop` effects, reachable from the frame handler without a stale
  // closure. An effect (not a render-phase write) keeps render pure for StrictMode replays.
  React.useEffect(() => {
    autoActionsRef.current = { pause: attributed => void pause(attributed) };
  }, [pause]);

  /**
   * Auto-stop needs a wall clock: no frames flow while paused, so the sample clock is frozen and
   * the machine cannot advance itself. Coarse polling is fine for a 20-minute decision, and this
   * is the ONE timer in the feature — everything during capture rides the sample clock.
   * Desktop's paused session is main's problem, so skip it there.
   */
  React.useEffect(() => {
    // `machineRef` is null on desktop and the machine is constructed disabled when the feature is
    // off, so this also keeps a feature-off session unchanged: no interval.
    if (control || state !== 'paused' || !autoPauseArmedRef.current) return;
    const id = setInterval(() => {
      applyAutoPauseEffects(machineRef.current?.tick(Date.now()));
    }, AUTO_STOP_POLL_MS);
    return () => clearInterval(id);
  }, [control, state, applyAutoPauseEffects]);

  const keepRecording = React.useCallback(() => {
    applyAutoPauseEffects(machineRef.current?.keepRecording());
    // The prompt was answered, so the run that raised it is stale — start the count over.
    watcherRef.current?.noteTranscribedSpeech();
  }, [applyAutoPauseEffects]);

  const pauseFromPrompt = React.useCallback(() => {
    applyAutoPauseEffects(machineRef.current?.pauseNow());
  }, [applyAutoPauseEffects]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      openingRef.current = null;
      if (!control) void stopRef.current();
    };
  }, [control]);

  return {
    state,
    isRecording: state === 'recording',
    isPaused: state === 'paused',
    micSilent,
    canPause: true,
    recordingId,
    noteId,
    completedRecording,
    startedAt,
    liveSegments,
    error,
    errorUser,
    clearError,
    gracePrompt,
    pauseReason,
    autoStopRequested,
    keepRecording,
    pauseFromPrompt,
    start,
    pause,
    resume,
    stop,
  };
}
