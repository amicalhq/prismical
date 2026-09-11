// RecordingPort — recording seam shared by the renderers. This file defines the shape only.
//
// The web adapter's raw WAV chunk upload — one of the two apiClient bypasses —
// moves behind this port.
// The browser capture pipeline (getUserMedia → worklet → chunker → this
// upload) is WEB-ONLY: on desktop the record button routes to main's native
// capture + transcription pipeline, which persists recordings and segments
// server-side itself, so the desktop renderer never implements this method.
// The dock/transcript UI state contract stays with
// the recording state machine in app-client — it is not part of this port.

/** A persisted transcript segment as returned by the chunk-transcribe lane. */
export interface RecordingTranscriptSegment {
  readonly id: string;
  readonly recordingId: string;
  readonly source: string;
  readonly speaker: string;
  readonly text: string;
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly segmentOrder: number;
}

// ---------------------------------------------------------------------------
// Native recording control — the desktop-only seam.
//
// On web the record button drives the browser MediaRecorder pipeline through
// `uploadTranscriptionChunk` above (getUserMedia → worklet → chunker → upload).
// On desktop that pipeline lives in MAIN's native RecordingService; the record
// button routes there over IPC instead. `useRecording` (app-client) detects the
// optional `control` below: when present it start/stop-via-IPC and mirrors main's
// pushed RecordingState into the SAME dock/transcript UI (so the shared component
// is capture-agnostic); when absent (web) it keeps the MediaRecorder path,
// byte-identical. Additive + inert on web — the web RecordingPort omits `control`.
// ---------------------------------------------------------------------------

export type NativeCaptureMode = 'mic' | 'system' | 'dual';

export type NativeRecordingStatus =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'error';

/**
 * The sanitized recording state MAIN pushes to the renderer (a projection of the
 * main-process RecordingService state — token-free by construction: ids, an enum
 * status, capture modes, transcript segments, and elapsed ms only). `captureMode`
 * is the mode actually capturing; when it differs from `requestedCaptureMode` the
 * permission gate degraded system/dual → mic (surface "mic only"). `segments`
 * accumulates the live transcript for the in-progress recording.
 */
export interface NativeRecordingState {
  readonly recordingId: string | null;
  readonly finalizingRecordingIds: readonly string[];
  readonly completedRecordings: readonly {
    readonly recordingId: string;
    readonly noteId: string | null;
    readonly segments: number;
  }[];
  readonly status: NativeRecordingStatus;
  readonly captureMode: NativeCaptureMode | null;
  /** Spoken language actually used by the active native recording. */
  readonly language?: string;
  readonly requestedCaptureMode: NativeCaptureMode | null;
  /** Whether this recording spends Cloud transcription quota, fixed by main at Start. */
  readonly spendsCloudQuota?: boolean | null;
  /** Cached allowance captured before Start; shared by every native window. */
  readonly quotaRemainingAtStartSeconds?: number | null;
  readonly micSource: 'meeting-app' | 'system-default' | 'unavailable';
  readonly noteId: string | null;
  readonly segments: readonly RecordingTranscriptSegment[];
  readonly elapsedMs: number;
  /**
   * Recording start (epoch ms), mirroring the desktop
   * wire schema. Optional because the web adapter and lightweight fixtures can
   * derive their timers without the native capture clock.
   */
  readonly startedAt?: number | null;
  readonly elapsedAt?: number | null;
  readonly pausedAccumMs?: number;
  /**
   * The live "Still there?" countdown, or null. Desktop's notify window renders the
   * CARD from main's own state; this crossing is what lets the shared in-app surfaces say
   * "Paused - no sound detected" rather than a bare "Paused", matching web.
   */
  readonly autoPausePrompt?: { readonly graceMs: number; readonly deadlineMs: number } | null;
  /** Main is asking the renderer to run its normal auto-stop. */
  readonly autoStopRequested?: boolean;
}

/**
 * Outcome of a native `start`: the minted recording id, or a typed reason the
 * recording did NOT begin — `permission-denied` (mic required but denied — no
 * capture spawned), `busy` (a recording is already active), `no-session` (no
 * signed-in session to record under). The mic-only degrade is NOT a failure — it
 * is a successful start surfaced through the pushed state's capture-mode fields.
 */
export type NativeStartResult =
  | { readonly ok: true; readonly recordingId: string }
  | { readonly ok: false; readonly reason: 'permission-denied' | 'busy' | 'no-session' | 'model-missing' | 'language-unsupported' | 'storage-unavailable' | 'suggestion-pending' | 'update-required' };

export interface NativeRecordingControl {
  /**
   * Start a native recording for `noteId` (the desktop capture mode is chosen by
   * the platform adapter — dual by default, degraded by the permission gate).
   * Resolves once the supervised pipeline is launched; the transition to
   * `recording` and the live segments arrive via `subscribe`.
   */
  start(input: {
    noteId: string | null;
    title: string;
    /** Validated ASR language code; main resolves the saved preference when available. */
    language?: string;
    /** Cached allowance before capture begins. Omitted when unknown or unlimited. */
    quotaRemainingAtStartSeconds?: number | null;
    /**
     * Auto-pause policy for this session, resolved renderer-side from the org's
     * feature gate + tuning. Passed per-start so the rules are fixed for the session's lifetime and
     * main needs no policy lookup of its own. Omitted ⇒ the feature is off.
     */
    autoPause?: {
      silenceSeconds: number;
      graceSeconds: number;
      autoStopAfterPausedMinutes: number;
    };
  }): Promise<NativeStartResult>;
  /** Gracefully stop + finalize the given recording (no-op if it is not active). */
  stop(recordingId: string): Promise<void>;
  /** Change later audio and finalization without changing the recording's provider/model. */
  setLanguage?(recordingId: string, language: string): Promise<boolean>;
  /** Claim the completed recording once across native windows. */
  claimCompletion(recordingId: string): Promise<boolean>;
  /** Pause/resume without ending or replacing the native recording. */
  pause(recordingId: string): Promise<boolean>;
  resume(recordingId: string): Promise<boolean>;
  /**
   * Subscribe to main's RecordingState pushes; the latest state is replayed
   * immediately (so a late subscriber never renders from nothing). Returns an
   * unsubscribe.
   */
  subscribe(listener: (state: NativeRecordingState) => void): () => void;
}

export interface RecordingPort {
  /**
   * Upload one WAV chunk of an in-progress recording; resolves with the
   * segments core persisted for it (empty for silence). Retrying the same
   * chunkIndex is safe — core rewrites that chunk's segment window
   * idempotently. Mirrors lib/api/transcription.ts#uploadTranscriptionChunk
   * so moving it between adapters is mechanical.
   */
  uploadTranscriptionChunk(
    recordingId: string,
    wav: ArrayBuffer,
    opts: {
      chunkIndex: number;
      chunkStartMs: number;
      authToken: string;
      activeOrgId: string;
    }
  ): Promise<RecordingTranscriptSegment[]>;
  /**
   * Native recording control (desktop only). Present ⇒ `useRecording`
   * routes start/stop + live segments through main's native pipeline instead of
   * the browser MediaRecorder path. Absent ⇒ web (the MediaRecorder path stays).
   */
  control?: NativeRecordingControl;
}
