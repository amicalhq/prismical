import {
  AbandonStagingResponseSchema,
  CompleteStagingResponseSchema,
  MintStagingUrlsResponseSchema,
  RecordingSpeakerResponseSchema,
  TranscriptionSettingsResponseSchema,
  type StagingAbandonReason,
  type StagingLane,
  type StagingLaneUpload,
} from '@prismical/api-contracts/apps/v1';
import { apiClient, ME_PREFIX } from './client';

export type {
  StagingAbandonReason,
  StagingLane,
  StagingLaneUpload,
} from '@prismical/api-contracts/apps/v1';

// Wire shapes from core (sync engine rows / transcribe endpoint).
export type CoreRecording = {
  id: string;
  noteId: string | null;
  title: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  /** Server bookkeeping: `meta.staging` (staged lanes) + `meta.finalize` (finalization lifecycle). */
  meta?: Record<string, unknown> | null;
};

/** One speaker in a recording's registry, minted by the finalize pass. */
export type CoreRecordingSpeaker = {
  id: string;
  recordingId: string;
  speakerKey: string; // 'you' | 'them' | 'dz:0' | 'dz:1' | …
  source: string; // 'channel' | 'diarization' | 'enrollment'
  displayName: string | null;
  personId: string | null;
};

export type CoreTranscriptSegment = {
  id: string;
  recordingId: string;
  source: string;
  speaker: string;
  text: string;
  startTimeMs: number;
  endTimeMs: number;
  segmentOrder: number;
  isFinal?: boolean;
};

type BoundAuthOptions = {
  activeOrgId?: string;
  authToken?: string;
};

export function createRecording(
  vars: {
    noteId: string;
    title: string;
    /** BYOK transcription default; omitted ⇒ managed Auto. */
    instanceId?: string;
    modelId?: string;
    /** 'multi' asks the provider to detect language; otherwise this is an ASR language code. */
    language?: string;
  },
  opts?: BoundAuthOptions
): Promise<CoreRecording> {
  const byok = vars.instanceId && vars.modelId;
  return apiClient.post<CoreRecording>(
    `${ME_PREFIX}/recordings`,
    {
      title: vars.title,
      captureMode: 'mic',
      status: 'recording',
      noteId: vars.noteId,
      startedAt: Date.now(),
      // The transcribe handler reads instanceId/modelId from here (set once at create). A managed
      // recording names NO model: which engine Prismical Cloud routes to is ours to change, the
      // client has no say in it, and anything written here ships inside the web bundle for anyone
      // to read. Server-side routing is opaque. BYOK is different — the owner
      // picked that model, so it is carried and echoed back to them.
      transcriptionConfig: {
        provider: byok ? 'byok' : 'prismical-cloud',
        model: byok ? vars.modelId : 'prismical-cloud',
        // Code-switching: non-English speech transcribes correctly instead of being force-decoded
        // as English. Core maps 'multi' to auto-detect for BYOK OpenAI ASR.
        language: vars.language ?? 'multi',
        ...(byok ? { instanceId: vars.instanceId, modelId: vars.modelId } : {}),
      },
    },
    opts
  );
}

export function finalizeRecording(
  recordingId: string,
  durationMs: number,
  stagingExpected: boolean,
  transcriptionDeferred: boolean,
  opts?: { endedAt?: number; activeOrgId?: string; authToken?: string }
): Promise<CoreRecording> {
  return apiClient.put<CoreRecording>(
    `${ME_PREFIX}/recordings/${recordingId}`,
    {
      status: 'completed',
      endedAt: opts?.endedAt ?? Date.now(),
      durationMs: Math.round(durationMs),
      stagingExpected,
      transcriptionDeferred,
    },
    { activeOrgId: opts?.activeOrgId, authToken: opts?.authToken }
  );
}

export function listNoteRecordings(noteId: string): Promise<CoreRecording[]> {
  return apiClient.list<CoreRecording>(`${ME_PREFIX}/recordings`, { noteId });
}

export function listTranscriptSegments(recordingId: string): Promise<CoreTranscriptSegment[]> {
  return apiClient.list<CoreTranscriptSegment>(`${ME_PREFIX}/transcript-segments`, { recordingId });
}

/** The org's client-facing transcription settings. Flat envelope. */
export function getTranscriptionSettings(
  opts?: BoundAuthOptions
): Promise<{ liveTranscription: boolean }> {
  return apiClient
    .getRaw<unknown>(`${ME_PREFIX}/transcription-settings`, undefined, opts)
    .then(response => TranscriptionSettingsResponseSchema.parse(response));
}

export function listRecordingSpeakers(recordingId: string): Promise<CoreRecordingSpeaker[]> {
  return apiClient.list<CoreRecordingSpeaker>(`${ME_PREFIX}/recording-speakers`, { recordingId });
}

/** Rename a speaker (null resets to the derived "Speaker N" label). Segments never change. */
export function renameRecordingSpeaker(
  speakerId: string,
  displayName: string | null
): Promise<CoreRecordingSpeaker> {
  return apiClient
    .patchRaw<unknown>(`${ME_PREFIX}/recording-speakers/${speakerId}`, {
      displayName,
    })
    .then(response => RecordingSpeakerResponseSchema.parse(response).result);
}

// The raw-WAV chunk upload is a JSON-apiClient bypass owned by the web RecordingPort adapter. It
// stays there because it reads the
// browser-host core URL and stamps auth headers directly. lib/recording's
// useRecording calls the injected RecordingPort instead. Desktop's record
// button routes to main's native capture pipeline (no renderer upload).

// ---- Audio staging --------------------------------------------------------------------------

/** Flat envelopes (postRaw): these endpoints return their body directly, not { result }. */
export function mintStagingUrls(
  recordingId: string,
  lanes: { lane: StagingLane; contentType: string }[],
  activeOrgId?: string,
  authToken?: string
): Promise<{ uploads: StagingLaneUpload[]; expiresAt: string }> {
  return apiClient
    .postRaw<unknown>(
      `${ME_PREFIX}/recordings/${recordingId}/staging/urls`,
      { lanes },
      { activeOrgId, authToken }
    )
    .then(response => MintStagingUrlsResponseSchema.parse(response));
}

export function completeStaging(
  recordingId: string,
  lanes: { lane: StagingLane; contentType: string; durationMs?: number }[],
  activeOrgId?: string,
  authToken?: string
): Promise<{ status: 'staged' | 'unchanged'; recordingId: string }> {
  return apiClient
    .postRaw<unknown>(
      `${ME_PREFIX}/recordings/${recordingId}/staging/complete`,
      { lanes },
      { activeOrgId, authToken }
    )
    .then(response => CompleteStagingResponseSchema.parse(response));
}

/** Release the pre-upload transcript blocker when this client cannot finish staging. */
export function abandonStaging(
  recordingId: string,
  reason: StagingAbandonReason,
  activeOrgId?: string,
  authToken?: string
): Promise<{ status: 'skipped' | 'unchanged'; recordingId: string }> {
  return apiClient
    .postRaw<unknown>(
      `${ME_PREFIX}/recordings/${recordingId}/staging/abandon`,
      { reason },
      { activeOrgId, authToken }
    )
    .then(response => AbandonStagingResponseSchema.parse(response));
}
