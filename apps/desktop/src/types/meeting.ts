export type AudioSource = "mic" | "system";
export type MeetingCaptureMode = AudioSource | "dual";
export type MeetingRuntimeState =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "error";
export type MeetingPersistenceState =
  | "recording"
  | "completed"
  | "failed"
  | "cancelled";
export type TranscriptSpeaker = "you" | "them";
export type MeetingArtifactType = "mic_wav" | "system_wav" | "debug_json";

export interface AudioFrame {
  source: AudioSource;
  samples: Float32Array;
  sampleRate: number;
  channels: number;
  timestampMs: number;
  durationMs: number;
  sequenceNum: number;
}

export interface TranscriptEvent {
  id: string;
  meetingId: string;
  noteId: number | null;
  source: AudioSource;
  speaker: TranscriptSpeaker;
  text: string;
  startTimeMs: number;
  endTimeMs: number;
  segmentOrder: number;
  isFinal: boolean;
  createdAt?: Date;
}

export interface MeetingRuntimeSnapshot {
  state: MeetingRuntimeState;
  mode: MeetingCaptureMode | null;
  meetingId: string | null;
  noteId: number | null;
  durationMs: number;
  startedAt?: number | null;
}

export interface MeetingListItem {
  id: string;
  noteId: number | null;
  title: string;
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number | null;
  captureMode: MeetingCaptureMode;
  state: MeetingPersistenceState;
  transcriptSegmentCount: number;
}

export interface MeetingDetail extends MeetingListItem {
  transcriptionModel: string | null;
  metadata: Record<string, unknown> | null;
  artifacts: Array<{
    id: string;
    artifactType: MeetingArtifactType;
    path: string;
    sizeBytes: number | null;
    createdAt: Date;
  }>;
  transcript: TranscriptEvent[];
}
