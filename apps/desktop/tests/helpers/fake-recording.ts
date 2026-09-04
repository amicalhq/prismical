/**
 * Headless fakes for the RecordingService tests: a fake
 * Capture (emits AudioFrames + a controllable awaitExit + release tracking) and
 * a fake WorkspaceBackend recording lane (records create/upload/finalize calls, returns
 * configurable RecordingLaneResults). NO real binary, no real cloud, no device.
 * Shared so recovery-drain tests can reuse the same fake cloud lane.
 */
import { Deferred, Effect, Layer, Option, Queue } from 'effect';
import type { TransportRequest, TransportResponse } from '@prismical/desktop-contracts';
import type { AudioFrame, CapturedAudioSource, MeetingCaptureMode } from '@/types/meeting';
import {
  Capture,
  type CaptureApi,
  type CaptureOptions,
  type CaptureRuntimeError,
  type CaptureSession,
  type CaptureSpawnError,
  type MicBindingCommand,
  type MicCaptureEvent,
} from '../../src/main/domains/recording/capture/service';
import {
  SystemPermissions,
  type MediaAccessStatus,
  type SystemPermissionsApi,
} from '../../src/main/infra/system-permissions/service';
import { AskStreamError } from '../../src/main/domains/transport/service';
import {
  WorkspaceBackend,
  type WorkspaceBackendApi,
  type CreateRecordingInput,
  type FinalizeRecordingInput,
  type RecordingLaneResult,
  type RecordingSegment,
  type StageLaneInput,
  type StagingAbandonReason,
  type TranscribeChunkParams,
} from '../../src/main/domains/transport/service';

// ---------------------------------------------------------------------------
// Fake Capture
// ---------------------------------------------------------------------------

export interface FakeCaptureSession {
  readonly mode: MeetingCaptureMode;
  readonly frames: Queue.Queue<AudioFrame>;
  readonly micEvents: Queue.Queue<MicCaptureEvent>;
  readonly terminated: Deferred.Deferred<void, CaptureRuntimeError>;
  readonly commands: MicBindingCommand[];
  readonly options: CaptureOptions | undefined;
  released: boolean;
}

export interface FakeCapture {
  readonly layer: Layer.Layer<Capture>;
  /** Every capture session ever acquired, in order (index N = the (N+1)-th spawn). */
  readonly sessions: FakeCaptureSession[];
  /** The most recently acquired session (throws if none yet). */
  readonly current: () => FakeCaptureSession;
  /** Fail the NEXT `capture` acquire with this spawn error (once). */
  readonly failNextSpawn: (error: CaptureSpawnError) => void;
}

export const makeFakeCapture = (): FakeCapture => {
  const sessions: FakeCaptureSession[] = [];
  let spawnErrorOnce: CaptureSpawnError | undefined;

  const capture: CaptureApi['capture'] = (mode, options) =>
    Effect.gen(function* () {
      if (spawnErrorOnce) {
        const error = spawnErrorOnce;
        spawnErrorOnce = undefined;
        return yield* Effect.fail(error);
      }
      const frames = yield* Queue.unbounded<AudioFrame>();
      const micEvents = yield* Queue.unbounded<MicCaptureEvent>();
      const terminated = yield* Deferred.make<void, CaptureRuntimeError>();
      const commands: MicBindingCommand[] = [];
      const record: FakeCaptureSession = {
        mode,
        frames,
        micEvents,
        terminated,
        commands,
        options,
        released: false,
      };
      // Scoped teardown: mark released (asserted as "child killed") + shut the queue.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          record.released = true;
        }).pipe(
          Effect.zipRight(Queue.shutdown(frames)),
          Effect.zipRight(Queue.shutdown(micEvents)),
        )
      );
      sessions.push(record);
      const session: CaptureSession = {
        mode,
        frames,
        aec: Effect.succeed(Option.none<string>()),
        micEvents,
        sendMicCommand: command => Effect.sync(() => void commands.push(command)),
        droppedFrames: Effect.succeed(0),
        awaitExit: Deferred.await(terminated),
      };
      return session;
    });

  return {
    layer: Layer.succeed(Capture, { capture }),
    sessions,
    current: () => {
      const last = sessions[sessions.length - 1];
      if (!last) throw new Error('no fake capture session acquired yet');
      return last;
    },
    failNextSpawn: error => {
      spawnErrorOnce = error;
    },
  };
};

/** Build a decoded AudioFrame (48 kHz mono, the native contract). */
export const fakeFrame = (
  source: CapturedAudioSource,
  samples: Float32Array,
  extra: Partial<Pick<AudioFrame, 'sequenceNum' | 'timestampMs' | 'sampleStartIndex' | 'durationMs'>> = {}
): AudioFrame => ({
  source,
  samples,
  sampleRate: 48_000,
  channels: 1,
  timestampMs: extra.timestampMs ?? 0,
  durationMs: extra.durationMs ?? Math.round((samples.length / 48_000) * 1000),
  sequenceNum: extra.sequenceNum ?? 0,
  sampleStartIndex: extra.sampleStartIndex ?? 0,
});

// ---------------------------------------------------------------------------
// Fake WorkspaceBackend recording lane
// ---------------------------------------------------------------------------

export const laneOk = <T>(value: T): RecordingLaneResult<T> => ({ ok: true, value });
export const laneFail = <T>(
  retryable: boolean,
  failure: Extract<RecordingLaneResult<T>, { ok: false }>['failure']
): RecordingLaneResult<T> => ({ ok: false, retryable, failure });

export interface UploadCall {
  readonly recordingId: string;
  readonly params: TranscribeChunkParams;
  readonly wav: Uint8Array;
}

export interface FakeWorkspaceBackend {
  readonly layer: Layer.Layer<WorkspaceBackend>;
  readonly createCalls: CreateRecordingInput[];
  readonly uploadCalls: UploadCall[];
  readonly finalizeCalls: Array<{ readonly recordingId: string; readonly input: FinalizeRecordingInput }>;
  readonly abandonCalls: Array<{
    readonly recordingId: string;
    readonly reason: StagingAbandonReason;
  }>;
  /** Every stageRecordingAudio call; only a cloud-engine recording or row stages. */
  readonly stageCalls: Array<{
    readonly recordingId: string;
    readonly lanes: readonly StageLaneInput[];
  }>;
  /** Unary `request` calls; the cloud-mode segment mirror POSTs land here. */
  readonly requestCalls: TransportRequest[];
  /**
   * Every lane call in arrival order (`request:<METHOD> <path>` / `upload:<index>` /
   * `finalize` / `abandon:<reason>`) — for ordering assertions (mirror BEFORE finalize).
   */
  readonly timeline: string[];
  readonly setRequestResponder: (fn: (req: TransportRequest) => TransportResponse) => void;
  readonly setCreateResponder: (
    fn: (input: CreateRecordingInput) => RecordingLaneResult<{ readonly recordingId: string }>
  ) => void;
  readonly setUploadResponder: (
    fn: (call: UploadCall) => RecordingLaneResult<readonly RecordingSegment[]>
  ) => void;
  readonly setFinalizeResponder: (
    fn: (recordingId: string, input: FinalizeRecordingInput) => RecordingLaneResult<{ readonly recordingId: string }>
  ) => void;
  readonly setAbandonResponder: (
    fn: (
      recordingId: string,
      reason: StagingAbandonReason
    ) => RecordingLaneResult<void>
  ) => void;
  readonly setStageResponder: (
    fn: (
      recordingId: string,
      lanes: readonly StageLaneInput[]
    ) => RecordingLaneResult<{ readonly staged: boolean }>
  ) => void;
}

export const makeFakeWorkspaceBackend = (): FakeWorkspaceBackend => {
  const createCalls: CreateRecordingInput[] = [];
  const uploadCalls: UploadCall[] = [];
  const finalizeCalls: Array<{ readonly recordingId: string; readonly input: FinalizeRecordingInput }> = [];
  const abandonCalls: Array<{
    readonly recordingId: string;
    readonly reason: StagingAbandonReason;
  }> = [];
  const requestCalls: TransportRequest[] = [];
  const stageCalls: Array<{
    readonly recordingId: string;
    readonly lanes: readonly StageLaneInput[];
  }> = [];
  const timeline: string[] = [];

  // The sync create dialect's happy answer (201 + echoed row) — tests that
  // exercise a failing mirror override it.
  let requestResponder: (req: TransportRequest) => TransportResponse = req => ({
    ok: true,
    status: 201,
    bodyJson: { success: true, result: req.body },
  });
  let createResponder: (input: CreateRecordingInput) => RecordingLaneResult<{ readonly recordingId: string }> =
    input => laneOk({ recordingId: input.recordingId });
  let uploadResponder: (call: UploadCall) => RecordingLaneResult<readonly RecordingSegment[]> = () => laneOk([]);
  let finalizeResponder: (
    recordingId: string,
    input: FinalizeRecordingInput
  ) => RecordingLaneResult<{ readonly recordingId: string }> = recordingId => laneOk({ recordingId });
  let abandonResponder: (
    recordingId: string,
    reason: StagingAbandonReason
  ) => RecordingLaneResult<void> = () => laneOk(undefined);
  // Staging disabled (the org-flag-off answer) by default — keeps every
  // existing expectation intact; staging tests override via setStageResponder.
  let stageResponder: (
    recordingId: string,
    lanes: readonly StageLaneInput[]
  ) => RecordingLaneResult<{ readonly staged: boolean }> = () => laneOk({ staged: false });

  const api: WorkspaceBackendApi = {
    // Only the segment mirror reaches `request`; the Ask/collab lanes stay inert stubs.
    request: req =>
      Effect.sync(() => {
        requestCalls.push(req);
        timeline.push(`request:${req.method} ${req.path}`);
        return requestResponder(req);
      }),
    openAskStream: () => Effect.fail(new AskStreamError({ reason: 'connect' })),
    collabToken: Effect.succeed('fake-collab-token'),
    createRecording: input =>
      Effect.sync(() => {
        createCalls.push(input);
        return createResponder(input);
      }),
    uploadTranscriptionChunk: (recordingId, params, wav) =>
      Effect.sync(() => {
        const call: UploadCall = { recordingId, params, wav };
        uploadCalls.push(call);
        timeline.push(`upload:${params.chunkIndex}`);
        return uploadResponder(call);
      }),
    finalizeRecording: (recordingId, input) =>
      Effect.sync(() => {
        finalizeCalls.push({ recordingId, input });
        timeline.push('finalize');
        return finalizeResponder(recordingId, input);
      }),
    stageRecordingAudio: (recordingId, lanes) =>
      Effect.sync(() => {
        stageCalls.push({ recordingId, lanes });
        timeline.push('stage');
        return stageResponder(recordingId, lanes);
      }),
    abandonRecordingStaging: (recordingId, reason) =>
      Effect.sync(() => {
        abandonCalls.push({ recordingId, reason });
        timeline.push(`abandon:${reason}`);
        return abandonResponder(recordingId, reason);
      }),
  };

  return {
    layer: Layer.succeed(WorkspaceBackend, api),
    createCalls,
    uploadCalls,
    finalizeCalls,
    abandonCalls,
    stageCalls,
    requestCalls,
    timeline,
    setRequestResponder: fn => {
      requestResponder = fn;
    },
    setCreateResponder: fn => {
      createResponder = fn;
    },
    setUploadResponder: fn => {
      uploadResponder = fn;
    },
    setFinalizeResponder: fn => {
      finalizeResponder = fn;
    },
    setAbandonResponder: fn => {
      abandonResponder = fn;
    },
    setStageResponder: fn => {
      stageResponder = fn;
    },
  };
};

// ---------------------------------------------------------------------------
// Fake SystemPermissions (the Electron edge)
// ---------------------------------------------------------------------------

export interface FakeSystemPermissions {
  readonly layer: Layer.Layer<SystemPermissions>;
  /** Mutable mic TCC status returned by `microphoneStatus`. */
  micStatus: MediaAccessStatus;
  /** What `askForMediaAccess` resolves to when prompted (status === not-determined). */
  requestGrants: boolean;
  /** Mutable OS product version returned by `systemVersion` (e.g. "14.2.1"). */
  systemVersion: string;
  /** How many times `requestMicrophoneAccess` (the OS prompt) was invoked. */
  readonly requestCalls: () => number;
}

/**
 * A fake SystemPermissions port for headless PermissionService/gate tests: NO
 * real TCC prompt, NO real electron. Defaults to a fully-capable macOS host
 * (mic granted, 14.2.1) so unrelated recording tests exercise the un-degraded
 * path; individual tests flip `micStatus` / `systemVersion` to drive the gate.
 */
export const makeFakeSystemPermissions = (
  init: Partial<Pick<FakeSystemPermissions, 'micStatus' | 'requestGrants' | 'systemVersion'>> = {}
): FakeSystemPermissions => {
  const state = {
    micStatus: init.micStatus ?? ('granted' as MediaAccessStatus),
    requestGrants: init.requestGrants ?? true,
    systemVersion: init.systemVersion ?? '14.2.1',
  };
  let requestCount = 0;

  const api: SystemPermissionsApi = {
    microphoneStatus: Effect.sync(() => state.micStatus),
    requestMicrophoneAccess: Effect.sync(() => {
      requestCount += 1;
      return state.requestGrants;
    }),
    systemVersion: Effect.sync(() => state.systemVersion),
  };

  return {
    layer: Layer.succeed(SystemPermissions, api),
    get micStatus() {
      return state.micStatus;
    },
    set micStatus(value) {
      state.micStatus = value;
    },
    get requestGrants() {
      return state.requestGrants;
    },
    set requestGrants(value) {
      state.requestGrants = value;
    },
    get systemVersion() {
      return state.systemVersion;
    },
    set systemVersion(value) {
      state.systemVersion = value;
    },
    requestCalls: () => requestCount,
  };
};

/** A transcript segment fixture as the server would echo for a non-empty chunk. */
export const fakeSegment = (
  recordingId: string,
  source: 'mic' | 'system',
  chunkIndex: number,
  text: string
): RecordingSegment => ({
  id: `tsg_${chunkIndex}`,
  recordingId,
  source,
  speaker: 'you',
  text,
  startTimeMs: chunkIndex * 5000,
  endTimeMs: chunkIndex * 5000 + 5000,
  segmentOrder: 1_000_000 + chunkIndex * 1000,
});
