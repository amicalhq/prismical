import type { SyncWriteEnvelope } from '@prismical/api-contracts/apps/v1';
import { RecordingSpeakerResponseSchema } from '@prismical/api-contracts/apps/v1';
import { apiClient, ME_PREFIX } from './client';

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
  /** Provider selection fixed at create plus current spoken language (managed models stay opaque). */
  transcriptionConfig?: Record<string, unknown> | null;
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
  return apiClient
    .post<SyncWriteEnvelope<CoreRecording>>(
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
        // to read. Server-side routing is opaque. BYOK is different —
        // the owner picked that model, so it is carried and echoed back to them.
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
    )
    .then(response => response.result);
}

/**
 * Change the spoken language of a recording that is still running. The chunk handler re-reads the
 * row per chunk and finalize reads it once at the end, so later audio follows the new pick; audio
 * already transcribed is not re-run. The column is a whole jsonb value, so the config as created is
 * sent back with only `language` changed.
 */
export function updateRecordingLanguage(
  recordingId: string,
  config: Record<string, unknown> | null | undefined,
  language: string,
  opts?: { activeOrgId?: string; authToken?: string }
): Promise<CoreRecording> {
  // The column is replaced whole: without the provider selection as created, the write would
  // turn a BYOK recording managed mid-flight. Better to leave the recording alone.
  if (!config || typeof config.provider !== 'string') {
    return Promise.reject(new Error('Recording configuration unavailable; language not applied'));
  }
  return apiClient
    .put<SyncWriteEnvelope<CoreRecording>>(
      `${ME_PREFIX}/recordings/${recordingId}`,
      { transcriptionConfig: { ...config, language } },
      {
        activeOrgId: opts?.activeOrgId,
        authToken: opts?.authToken,
        signal: AbortSignal.timeout(15_000),
      }
    )
    .then(response => response.result);
}

export function finalizeRecording(
  recordingId: string,
  durationMs: number,
  opts?: { endedAt?: number; activeOrgId?: string; authToken?: string }
): Promise<CoreRecording> {
  return apiClient
    .put<SyncWriteEnvelope<CoreRecording>>(
      `${ME_PREFIX}/recordings/${recordingId}`,
      {
        status: 'completed',
        endedAt: opts?.endedAt ?? Date.now(),
        durationMs: Math.round(durationMs),
      },
      {
        activeOrgId: opts?.activeOrgId,
        authToken: opts?.authToken,
        signal: AbortSignal.timeout(30_000),
      }
    )
    .then(response => {
      const recording = response?.result;
      if (recording?.id !== recordingId || recording.status !== 'completed') {
        throw new Error('Invalid recording completion acknowledgement');
      }
      return recording;
    });
}

export function listNoteRecordings(noteId: string): Promise<CoreRecording[]> {
  return apiClient.list<CoreRecording>(`${ME_PREFIX}/recordings`, { noteId });
}

export function listTranscriptSegments(recordingId: string): Promise<CoreTranscriptSegment[]> {
  return apiClient.list<CoreTranscriptSegment>(`${ME_PREFIX}/transcript-segments`, { recordingId });
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
    .then(response => RecordingSpeakerResponseSchema.parse(response));
}

// The raw-WAV chunk upload is a JSON-apiClient bypass owned by the web RecordingPort adapter. It
// stays there because it reads the
// browser-host core URL and stamps auth headers directly. lib/recording's
// useRecording calls the injected RecordingPort instead. Desktop's record
// button routes to main's native capture pipeline (no renderer upload).
