'use client';

import * as React from 'react';
import { ChunkBoundaryPicker } from './chunker';
import {
  appendAudioFrame,
  createAudioSession,
  holdAudioCapture,
  listAudioSessions,
  queueAudioChunk,
  stopAudioSession,
} from './audio-outbox';
import { drainAudioSession, type AudioDrainResult } from './audio-outbox-drain';
import {
  createRecording,
  finalizeRecording,
  type CoreTranscriptSegment,
} from '../api/transcription';
import {
  listPendingRecordingCompletions,
  removePendingRecordingCompletion,
  type PendingRecordingCompletion,
} from './recording-completion';
import { AutoPauseMachine, SilenceWatcher, type AutoPauseEffect } from '@prismical/silence';
import { ensureAutoPausePolicy } from '../api/hooks/organizations';
import { usageKey, usageKeyPrefix, type Usage } from '../api/hooks/usage';
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
// Dead-mic detection: a capture stream whose samples are exactly
// zero is broken — most commonly macOS revoking the browser's mic permission (a Chrome
// update can wedge it), where getUserMedia still "succeeds" and the tab shows recording
// but CoreAudio delivers pure digital silence. A real mic in a dead-quiet room never
// reads 0 — its noise floor sits around 1e-3 — so exact zeros for several seconds can
// only be a dead stream (or a hardware-muted mic, which deserves the same warning).
const SILENT_MIC_PEAK = 1e-6;
const SILENT_MIC_SECONDS = 4;
// Auto-pause never fires in the opening seconds of a session: pausing right
// after the user pressed record reads as "the button is broken", and the chunker's warm-up window
// is where cadence is least representative anyway.
const MIN_SESSION_SECONDS_BEFORE_AUTO_PAUSE = 30;
// How often the paused session checks the auto-stop deadline. Coarse on purpose — it is a
// 20-minute decision, and this timer only exists because no frames flow while paused.
const AUTO_STOP_POLL_MS = 5_000;
type RecordingErrorKey = ApplicationTranslationKey;

const COMPLETION_RECOVERY_ERROR: RecordingErrorKey = 'recording.errors.completionRecovery';

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

export function nativeNotice(state: NativeRecordingState): RecordingErrorKey | null {
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
  /** Keep the microphone source alive while the session can resume after suspension. */
  source: MediaStreamAudioSourceNode | null;
  picker: ChunkBoundaryPicker | null;
  recordingId: string | null;
  segmentCount: number;
  /** Frames and chunk boundaries commit in capture order, before network delivery. */
  writes: Promise<void>;
  pendingSamples: number;
  storageFailed: boolean;
  releaseCapture: () => void;
  /** Identity frozen with the session so a later account/org switch cannot claim its recovery. */
  ownerSub: string;
  ownerOrgId: string;
  ownerSessionKey: string;
  /** Set before local teardown so queued async work cannot cross into a new login. */
  cancelled: boolean;
}

const activeRecordingCompletions = new Set<string>();

async function finishRecordingCompletion(recordingId: string): Promise<void> {
  removePendingRecordingCompletion(recordingId);
}

function recordingRecoveryLock(recordingId: string): string {
  return `prismical-recording-recovery:${recordingId}`;
}

async function recoverPendingCompletion(
  item: PendingRecordingCompletion,
  auth: AuthPort,
  onFinalized?: () => void
): Promise<boolean> {
  if (navigator.locks) {
    return navigator.locks.request(
      recordingRecoveryLock(item.recordingId),
      { ifAvailable: true },
      lock => (lock ? recoverPendingCompletionLocked(item, auth, onFinalized) : false)
    );
  }
  return recoverPendingCompletionLocked(item, auth, onFinalized);
}

async function recoverPendingCompletionLocked(
  item: PendingRecordingCompletion,
  auth: AuthPort,
  onFinalized?: () => void
): Promise<boolean> {
  if (activeRecordingCompletions.has(item.recordingId)) return false;
  activeRecordingCompletions.add(item.recordingId);
  try {
    try {
      const authToken = await boundAuthToken(auth, item.ownerSessionKey);
      await finalizeRecording(item.recordingId, item.durationMs, {
        endedAt: item.endedAt,
        activeOrgId: item.ownerOrgId,
        authToken,
      });
    } catch (err) {
      if (err instanceof RecordingSessionChangedError) return false;
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
        await finishRecordingCompletion(item.recordingId);
        return true;
      }
      console.warn('recording completion recovery failed', err);
      return false;
    }
    if (!ownsActiveContext(auth, item.ownerSessionKey)) return false;
    await finishRecordingCompletion(item.recordingId);
    onFinalized?.();
    return true;
  } finally {
    activeRecordingCompletions.delete(item.recordingId);
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
  /** Capture is closed, but this recording still has uploads/completion pending. */
  isFinalizing: boolean;
  /** When the active session started (ISO), anchoring the live lines' wall-clock times. */
  startedAt: string | null;
  /** Main's pause-aware media clock; null for browser capture. */
  nativeElapsed: Pick<NativeRecordingState, 'status' | 'elapsedMs' | 'elapsedAt'> | null;
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
  skipAutoEnhanceForNote,
}: { handleCompletion?: boolean; skipAutoEnhanceForNote?: string } = {}): UseRecording {
  const [state, setState] = React.useState<RecState>('idle');
  const [recordingId, setRecordingId] = React.useState<string | null>(null);
  const [noteId, setNoteId] = React.useState<string | null>(null);
  const [finalizingIds, setFinalizingIds] = React.useState<Set<string>>(() => new Set());
  const finalizingIdsRef = React.useRef(finalizingIds);
  React.useEffect(() => {
    finalizingIdsRef.current = finalizingIds;
  }, [finalizingIds]);
  const [completedRecording, setCompletedRecording] =
    React.useState<UseRecording['completedRecording']>(null);
  const openingRef = React.useRef<object | null>(null);
  const mountedRef = React.useRef(true);
  const [startedAt, setStartedAt] = React.useState<string | null>(null);
  const [nativeElapsed, setNativeElapsed] = React.useState<UseRecording['nativeElapsed']>(null);
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
  /** Whether this session has auto-pause enabled. */
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
      // The seconds just metered move the sidebar quota meter. Keyed by the shared prefix so the
      // active org's entry is refetched without this lane having to resolve which org that is.
      void qc.invalidateQueries({ queryKey: usageKeyPrefix });
      analytics.capture(EVENTS.RECORDING_COMPLETED, {
        note_id: finished.noteId,
        recording_id: finished.recordingId,
        segments: finished.segments,
      });
      if (getAutoEnhanceEnabled() && finished.noteId !== skipAutoEnhanceForNote)
        useAutoEnhanceStore.getState().requestAutoEnhance(
          {
            noteId: finished.noteId,
            recordingId: finished.recordingId,
            ownerSessionKey: finished.ownerSessionKey,
            ownerOrgId: finished.ownerOrgId,
            source: 'auto-enhance',
          },
          analytics
        );
      if (mountedRef.current) setCompletedRecording(finished);
    },
    [analytics, qc, skipAutoEnhanceForNote]
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
  const nativeOwnersRef = React.useRef(new Map<string, {
    sessionKey: string | null;
    orgId: string | null;
    segments: number;
  }>());
  const nativeClaimsRef = React.useRef(new Set<string>());
  const nativeCaptureRef = React.useRef<NativeRecordingState | null>(null);

  // Native bridge (desktop): mirror main's pushed RecordingState into the SAME
  // dock/transcript state the web path drives, so the shared components can't
  // tell which capture produced the frames. No-op on web (no control). Main owns
  // the create/chunk/finalize lane; the renderer only reflects state here.
  React.useEffect(() => {
    if (!control) return;
    return control.subscribe(s => {
      nativeCaptureRef.current = s;
      const ids = new Set([
        ...(s.recordingId ? [s.recordingId] : []),
        ...s.finalizingRecordingIds,
        ...s.completedRecordings.map(result => result.recordingId),
      ]);
      const view = auth.getSession();
      for (const id of ids) {
        if (!nativeOwnersRef.current.has(id)) nativeOwnersRef.current.set(id, {
          sessionKey: exactSessionKey(view),
          orgId: activeOrgIdOf(view),
          segments: 0,
        });
      }
      for (const id of nativeOwnersRef.current.keys()) {
        if (!ids.has(id)) {
          nativeOwnersRef.current.delete(id);
          nativeClaimsRef.current.delete(id);
        }
      }
      if (s.recordingId) nativeOwnersRef.current.get(s.recordingId)!.segments = s.segments.length;
      setFinalizingIds(new Set(s.finalizingRecordingIds));
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
      setNativeElapsed(previous =>
        previous?.status === s.status &&
        previous.elapsedMs === s.elapsedMs &&
        previous.elapsedAt === s.elapsedAt
          ? previous
          : { status: s.status, elapsedMs: s.elapsedMs, elapsedAt: s.elapsedAt }
      );
      setRecordingId(s.recordingId);
      setNoteId(s.noteId);
      for (const result of s.completedRecordings) {
        const ownership = nativeOwnersRef.current.get(result.recordingId)!;
        ownership.segments = result.segments;
        if (!handleCompletion || !result.noteId || nativeClaimsRef.current.has(result.recordingId))
          continue;
        const owner = ownership.sessionKey;
        const ownerOrgId = ownership.orgId;
        if (owner && ownerOrgId && ownsActiveContext(auth, owner)) {
          const finished = {
            recordingId: result.recordingId,
            noteId: result.noteId,
            segments: result.segments,
            ownerSessionKey: owner,
            ownerOrgId,
          };
          nativeClaimsRef.current.add(result.recordingId);
          void control
            .claimCompletion(result.recordingId)
            .then(claimed => {
              if (claimed && exactSessionKey(auth.getSession()) === owner) {
                finishRecording(finished);
              }
              if (!claimed) nativeClaimsRef.current.delete(result.recordingId);
            })
            .catch(() => nativeClaimsRef.current.delete(result.recordingId));
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
  // (createRecording) plus getUserMedia.
  // Desktop's native pipeline has neither, and failures here are fine (start() re-does both).
  React.useEffect(() => {
    if (control) return;
    void fetch('/audio-recorder-processor.js').catch(() => {});
    void ensureModelDefault(qc, 'transcription').catch(() => {});
  }, [control, qc]);

  const receiveAudioDrain = React.useCallback(
    (result: AudioDrainResult, source?: RecordingSession) => {
      const current = session.current;
      const visible =
        !openingRef.current && (!current || current.recordingId === result.recordingId);
      if (source) source.segmentCount += result.segments.length;
      if (result.error && visible) {
        const key: RecordingErrorKey =
          result.error instanceof ApiError && result.error.code === 'TRANSCRIPTION_QUOTA_EXCEEDED'
            ? 'recording.errors.quotaExceeded'
            : 'recording.errors.someAudioNotTranscribed';
        const user = aiUserErrorOf(result.error);
        setServerError(user ? { key, user } : null);
        setError(key);
      }
      if (result.segments.length) {
        const s = session.current;
        if (
          s &&
          result.segments[0]?.recordingId === s.recordingId &&
          !s.cancelled &&
          !openingRef.current
        ) {
          watcherRef.current?.noteTranscribedSpeech();
          const effects = machineRef.current?.speechTranscribed();
          if (effects?.some(effect => effect.kind === 'hide-grace')) setGracePrompt(null);
          segmentCountRef.current += result.segments.length;
          setLiveSegments(previous =>
            [...previous, ...result.segments].sort(
              (a, b) => a.startTimeMs - b.startTimeMs || a.segmentOrder - b.segmentOrder
            )
          );
        }
        void qc.invalidateQueries({ queryKey: transcriptKey(result.segments[0]!.recordingId) });
      }
      if (!result.pending)
        setFinalizingIds(ids => {
          const next = new Set(ids);
          next.delete(result.recordingId);
          return next;
        });
      if (result.completed) {
        const row = result.completed;
        // An opening failure may leave an empty durable intent. Settle it without
        // announcing a recording or requesting enhancement for audio never captured.
        if (row.capturedSamples === 0) return;
        if (visible)
          setError(previous =>
            previous === COMPLETION_RECOVERY_ERROR ||
            previous === 'recording.errors.someAudioNotTranscribed' ||
            previous === 'recording.errors.quotaExceeded'
              ? null
              : previous
          );
        if (visible) setServerError(null);
        finishRecording({
          recordingId: row.recordingId,
          noteId: row.noteId,
          segments: source?.segmentCount ?? 0,
          ownerSessionKey: row.ownerSessionKey,
          ownerOrgId: row.ownerOrgId,
        });
      }
    },
    [finishRecording, qc]
  );

  // Retry owned finalization and upload intents on launch, reconnection, focus,
  // and while unresolved work remains in this session.
  React.useEffect(() => {
    if (control) return;
    let cancelled = false;
    let retryTimer: number | null = null;
    let draining = false;
    const drain = async () => {
      if (draining || cancelled) return;
      draining = true;
      try {
        if (retryTimer !== null) {
          window.clearTimeout(retryTimer);
          retryTimer = null;
        }
        let unresolved = false;
        let pendingAudio = false;
        const view = auth.getSession();
        const activeSub = view.activeSub ?? null;
        const activeSessionKey = view.activeSessionKey ?? view.activeSub ?? null;
        const activeOrgId = activeOrgIdOf(view);
        // A sibling tab may finish delivery and delete the shared outbox intent without
        // this hook receiving its drain result. Snapshot tracked IDs before the async read
        // so this sweep cannot clear a recording that started stopping during that read.
        const previouslyFinalizing = finalizingIdsRef.current;
        const audio = await listAudioSessions();
        if (cancelled) return;
        const retainedIds = new Set(audio.map(item => item.recordingId));
        const deliveredElsewhere = [...previouslyFinalizing].filter(
          id => !retainedIds.has(id) && session.current?.recordingId !== id
        );
        if (deliveredElsewhere.length) {
          setFinalizingIds(ids => {
            const next = new Set(ids);
            for (const id of deliveredElsewhere) next.delete(id);
            return next;
          });
          for (const id of deliveredElsewhere)
            void qc.invalidateQueries({ queryKey: transcriptKey(id) });
          void qc.invalidateQueries({ queryKey: ['recordings'] });
          void qc.invalidateQueries({ queryKey: ['note-recordings'] });
          void qc.invalidateQueries({ queryKey: ['enhanced-recordings'] });
          void qc.invalidateQueries({ queryKey: usageKeyPrefix });
          // The delivering tab owns completion/auto-enhance; only refresh this observer.
        }
        for (const item of audio) {
          if (cancelled) return;
          if (item.ownerSub !== activeSub || item.ownerSessionKey !== activeSessionKey) continue;
          const live = session.current?.recordingId === item.recordingId;
          const source = live ? (session.current ?? undefined) : undefined;
          const result = await drainAudioSession(item.recordingId, auth, recording, {
            recoverInterrupted: !live,
            isActive: () => !cancelled,
          });
          if (cancelled) return;
          receiveAudioDrain(result, source);
          if (result.pending) pendingAudio = true;
          if (result.pending && item.stoppedAt !== undefined)
            setFinalizingIds(ids => new Set(ids).add(item.recordingId));
          if (result.pending && !live && (result.retrying || result.error)) unresolved = true;
        }
        const recoveries = new Map(
          listPendingRecordingCompletions().map(item => [item.recordingId, item])
        );
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
          if (
            !(await recoverPendingCompletion(item, auth, () => {
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
        if (!openingRef.current && (!session.current || session.current.phase === 'stopping'))
          setError(previous =>
            unresolved
              ? COMPLETION_RECOVERY_ERROR
              : previous === COMPLETION_RECOVERY_ERROR && !pendingAudio
                ? null
                : previous
          );
      } catch (error) {
        console.warn('audio recovery unavailable', error);
      } finally {
        draining = false;
        if (!cancelled) retryTimer = window.setTimeout(() => void drain(), 5000);
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
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [auth, control, finishRecording, recording, receiveAudioDrain, qc]);

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
    s.source?.disconnect();
    s.stream?.getTracks().forEach(t => t.stop());
    void s.ctx?.close().catch(() => {});
    s.ctx = null;
    s.stream = null;
    s.node = null;
    s.source = null;
  }, []);

  // A recording belongs to an exact login slot, not merely a user + org. Stop
  // all local work when that slot changes so a same-sub ordinary session can
  // never inherit support-origin capture, retries, or completion recovery.
  React.useEffect(() => {
    if (control) return;
    return auth.onSessionChanged(view => {
      const s = session.current;
      if (!s || ownsSessionContext(view, s.ownerSessionKey)) return;
      s.cancelled = true;
      pauseEpochRef.current += 1;
      teardownAudio();
      session.current = null;
      void s.writes.then(s.releaseCapture, s.releaseCapture);
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

  const enqueueChunk = React.useCallback(
    (samples: Float32Array) => {
      const s = session.current;
      if (!s?.recordingId || samples.length === 0 || s.storageFailed) return;
      const id = s.recordingId;
      s.writes = s.writes.then(() => queueAudioChunk(id, samples.length));
      void s.writes
        .then(() => drainAudioSession(id, auth, recording))
        .then(result => receiveAudioDrain(result, s))
        .catch(() => {
          s.storageFailed = true;
          if (session.current === s && !openingRef.current) {
            setError('recording.errors.storageUnavailable');
            void stopRef.current();
          }
        });
    },
    [auth, recording, receiveAudioDrain]
  );

  const start = React.useCallback(
    async (noteId: string, title: string) => {
      // Desktop: route to main's native pipeline (no getUserMedia, no chunk
      // upload). The recording → live-segments transitions arrive via the state
      // push above; here we only reflect start intent + a failed start's reason.
      if (control) {
        if (state !== 'idle' || openingRef.current || !mountedRef.current) return;
        const opening = {};
        openingRef.current = opening;
        const owner = auth.getSession();
        const ownerSessionKey = exactSessionKey(owner);
        const ownerOrgId = activeOrgIdOf(owner);
        const stillOwned = () => openingRef.current === opening && mountedRef.current &&
          exactSessionKey(auth.getSession()) === ownerSessionKey &&
          activeOrgIdOf(auth.getSession()) === ownerOrgId;
        setError(null);
        // Bind the starting UI before awaiting policy or the native recorder.
        setNoteId(noteId);
        setRecordingId(null);
        setStartedAt(null);
        setCompletedRecording(null);
        setState('starting');
        setLiveSegments([]);
        segmentCountRef.current = 0;
        try {
          // Desktop runs the same machine in main — it only needs the policy.
          const policy = await ensureAutoPausePolicy(qc, ownerOrgId);
          if (!stillOwned()) return;
          // Main keeps this pre-capture estimate for every window. A later usage response
          // already includes this recording's chunks and cannot serve as its starting allowance.
          const usage = qc.getQueryData<Usage>(usageKey(ownerOrgId));
          const quota = usage?.quota?.cloudTranscription;
          const quotaRemainingAtStartSeconds =
            quota?.limitSeconds != null ? Math.max(0, quota.limitSeconds - quota.usedSeconds) : null;
          const result = await control.start({
            noteId,
            title,
            ...(quotaRemainingAtStartSeconds !== null ? { quotaRemainingAtStartSeconds } : {}),
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
          if (!stillOwned()) return;
          const pushed = nativeCaptureRef.current;
          const captureInProgress = pushed && pushed.status !== 'idle' && pushed.status !== 'error';
          if (captureInProgress && (!result.ok || pushed.recordingId !== result.recordingId)) return;
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
                      : result.reason === 'suggestion-pending'
                        ? 'recording.actions.reviewBeforeRecording'
                        : 'recording.errors.couldNotStart'
            );
            return;
          }
          setRecordingId(result.recordingId);
        } finally {
          if (openingRef.current === opening) openingRef.current = null;
        }
        return;
      }
      if (session.current?.phase === 'stopping' && !session.current.ctx) session.current = null;
      if (session.current || openingRef.current || !mountedRef.current) return;
      const opening = {};
      openingRef.current = opening;
      const assertOpening = () => {
        if (openingRef.current !== opening || !mountedRef.current)
          throw new RecordingSessionChangedError();
      };
      setNoteId(noteId);
      setRecordingId(null);
      setStartedAt(null);
      setLiveSegments([]);
      segmentCountRef.current = 0;
      setCompletedRecording(null);
      setError(null);
      setMicSilent(false);
      silentRunRef.current = 0;
      setState('starting');
      let openingStream: MediaStream | null = null;
      let openingContext: AudioContext | null = null;
      let openingNode: AudioWorkletNode | null = null;
      let releaseCapture: (() => void) | undefined;
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
        const preferences = getRecordingPreferences();
        authToken = await boundAuthToken(auth, ownerSessionKey);
        const rec = await createRecording(
          { noteId, title, ...modelParams, language: transcriptionLanguageFor(preferences) },
          { activeOrgId: ownerOrgId, authToken }
        );
        assertOpening();
        releaseCapture = await holdAudioCapture(rec.id);
        await createAudioSession({
          recordingId: rec.id,
          noteId,
          ownerSub,
          ownerOrgId,
          ownerSessionKey,
        });
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
          enabled: policy.enabled,
          silenceSeconds: policy.silenceSeconds,
          graceSeconds: policy.graceSeconds,
          autoStopAfterPausedMinutes: policy.autoStopAfterPausedMinutes,
          minSessionSeconds: MIN_SESSION_SECONDS_BEFORE_AUTO_PAUSE,
        });
        autoPauseArmedRef.current = policy.enabled;
        setGracePrompt(null);
        setPauseReason(null);
        setAutoStopRequested(false);

        session.current = {
          noteId,
          phase: 'recording',
          ctx: openingContext,
          stream: openingStream,
          node: openingNode,
          source,
          picker: new ChunkBoundaryPicker(SAMPLE_RATE),
          recordingId: rec.id,
          segmentCount: 0,
          writes: Promise.resolve(),
          pendingSamples: 0,
          storageFailed: false,
          releaseCapture,
          ownerSub,
          ownerOrgId,
          ownerSessionKey,
          cancelled: false,
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
          const capture = activeSession;
          if (capture.storageFailed) return;
          capture.pendingSamples += frame.length;
          if (capture.pendingSamples > SAMPLE_RATE * 60) {
            capture.storageFailed = true;
            setError('recording.errors.storageUnavailable');
            void stopRef.current();
            return;
          }
          capture.writes = capture.writes.then(() => appendAudioFrame(rec.id, frame));
          void capture.writes
            .then(() => {
              capture.pendingSamples -= frame.length;
            })
            .catch(() => {
              capture.storageFailed = true;
              if (session.current === capture && !openingRef.current) {
                setError('recording.errors.storageUnavailable');
                void stopRef.current();
              }
            });
          detectSilentMic(frame);
          const s = session.current;
          if (!s) return;
          // Update auto-pause from the captured audio.
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
        releaseCapture?.();
        openingNode?.port.close();
        openingNode?.disconnect();
        openingStream?.getTracks().forEach(track => track.stop());
        void openingContext?.close().catch(() => {});
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
  // durable sample offsets and the chunker doesn't re-run its warm-up burst.
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
      const rest = s.picker?.flush();
      if (rest) enqueueChunk(rest);
      try {
        await s.ctx?.suspend();
      } catch {
        if (pauseEpochRef.current === epoch) {
          // The context refused to suspend ⇒ frames are still flowing. Never leave capture
          // running under a "Paused" UI — revert and say so.
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
      try {
        analytics.capture(EVENTS.RECORDING_STOP_REQUESTED, {
          client_at_ms: Date.now(),
          recording_id: id,
        });
      } catch {
        /* Diagnostics must not prevent Stop. */
      }
      setState('stopping');
      const ownership = nativeOwnersRef.current.get(id);
      await control.stop(id);
      return { segments: ownership?.segments ?? 0 };
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
    try {
      analytics.capture(EVENTS.RECORDING_STOP_REQUESTED, {
        client_at_ms: Date.now(),
        recording_id: s.recordingId,
      });
    } catch {
      /* Diagnostics must not prevent Stop. */
    }
    s.phase = 'stopping';
    if (s.recordingId) setFinalizingIds(ids => new Set(ids).add(s.recordingId!));
    setState('stopping');
    const stopOwnedSession = async () => {
      try {
        s.node?.port.postMessage({ type: 'flush' });
        await new Promise(resolve => setTimeout(resolve, 150));
        teardownAudio();
        // Capture is closed; retained writes/uploads must not block a new recording.
        setState('idle');
        setGracePrompt(null);
        setPauseReason(null);
        setAutoStopRequested(false);
        applyAutoPauseEffects(machineRef.current?.noteStopped());
        // Wait for every accepted frame and boundary to commit. On write failure the
        // retained prefix remains recoverable; stopAudioSession uses its durable length.
        await s.writes.catch(() => {});
        if (!s.recordingId) return { segments: segmentCountRef.current };
        await stopAudioSession(s.recordingId, Date.now());
        s.releaseCapture();
        if (!s.cancelled && ownsActiveContext(auth, s.ownerSessionKey)) {
          const result = await drainAudioSession(s.recordingId, auth, recording);
          receiveAudioDrain(result, s);
          if (
            result.pending &&
            (result.retrying || result.error) &&
            !s.storageFailed &&
            session.current === s &&
            !openingRef.current
          )
            setError(COMPLETION_RECOVERY_ERROR);
        }
      } catch (error) {
        console.warn('recording stop retained for recovery', error);
        if (session.current === s && !openingRef.current)
          setError(
            s.storageFailed ? 'recording.errors.storageUnavailable' : COMPLETION_RECOVERY_ERROR
          );
      } finally {
        s.releaseCapture();
        if (session.current === s) {
          teardownAudio();
          session.current = null;
          setState('idle');
          setGracePrompt(null);
          setPauseReason(null);
          setAutoStopRequested(false);
          applyAutoPauseEffects(machineRef.current?.noteStopped());
        }
        window.dispatchEvent(new Event('recording-recovery-pending'));
      }
      return { segments: s.segmentCount };
    };
    s.stopPromise = stopOwnedSession();
    return s.stopPromise;
  }, [
    control,
    recordingId,
    state,
    teardownAudio,
    applyAutoPauseEffects,
    auth,
    analytics,
    recording,
    receiveAudioDrain,
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
    isFinalizing: state === 'stopping' || (recordingId !== null && finalizingIds.has(recordingId)),
    startedAt,
    nativeElapsed,
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
