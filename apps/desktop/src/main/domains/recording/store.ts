/**
 * RecordingStore — the persistence half of the recording
 * lane: a WORKSPACE-scoped store over the ProductDb (both branches mount one —
 * local over local.db, cloud over the per-(sub, org) cache), so a recording's
 * row + transcript segments survive the session and the local backend's
 * GET /apps/v1/me/recordings|transcript-segments delta lanes serve them.
 *
 * Ops fail typed (ProductDbError) like the NoteBodyStore; the CALL SITES in
 * live.ts / recovery-drain.ts fold every failure to a warn log — a product-db
 * hiccup must never break the audio path or the drain.
 */
import { Context, type Effect } from 'effect';
import type { ProductDbError } from '../../infra/product-db/service';
import type { RecordingSegment } from '../transport/service';

/**
 * The recording row at start — the SAME fields the cloud create body carries
 * (transport/live.ts makeCreateRecording). `startedAt` is the lane's epoch-ms
 * Clock value; the store persists it as ISO text (schema convention — the sync
 * dialect serves ISO and the renderer does `new Date(startedAt)`).
 */
export interface RecordingStartFields {
  readonly id: string;
  readonly title: string;
  readonly captureMode: 'mic' | 'system' | 'dual';
  readonly status: 'recording';
  readonly noteId: string | null;
  /** Recording start, epoch ms (Clock). */
  readonly startedAt: number;
  readonly transcriptionConfig?: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;
}

/** Graceful-stop outcome — the lane's Clock end + pause-compressed media duration. */
export interface RecordingEndFields {
  /** Recording end, epoch ms (Clock). */
  readonly endedAt: number;
  /** Pause-compressed media time (mediaDurationMs) — stored as given, never recomputed. */
  readonly durationMs: number;
}

export interface RecordingStoreApi {
  /**
   * Upsert the recording row at start. Upsert (not insert) so a re-entrant
   * write — e.g. a drain resolving a recording whose start already persisted —
   * replaces the fields instead of failing, keeping the original createdAt.
   */
  readonly recordingStarted: (
    fields: RecordingStartFields
  ) => Effect.Effect<void, ProductDbError>;
  /** Finalize: status 'completed' + endedAt/durationMs + updatedAt bump (existing row only). */
  readonly recordingCompleted: (
    id: string,
    end: RecordingEndFields
  ) => Effect.Effect<void, ProductDbError>;
  /** Capture give-up: status 'failed' + updatedAt bump — only if the row exists (never fabricates). */
  readonly recordingFailed: (id: string) => Effect.Effect<void, ProductDbError>;
  /**
   * Persist the wire rows a transcribe call returned. The runtime objects
   * carry the full 13-field server row (main's RecordingSegment type declares
   * 8 — parseSegments is a cast); the store normalizes the untyped extras
   * (isFinal ?? true, createdAt/updatedAt ?? now, deletedAt ?? null) and
   * writes ON CONFLICT (recordingId, segmentOrder) DO UPDATE: a retried chunk
   * re-minted a NEW tsg_ id server-side, so the (recordingId, segmentOrder)
   * window — not the id — is the identity.
   */
  readonly segmentsReceived: (
    segments: readonly RecordingSegment[]
  ) => Effect.Effect<void, ProductDbError>;
  /**
   * Merge `patch` into the row's `meta`: numeric keys take
   * the MAX of stored and patched (the server's detectedSpeakerCount rule —
   * a running max across chunks/passes), every other key shallow-overwrites.
   * Existing rows only (never fabricates); bumps updatedAt so the sync delta
   * lanes see it.
   */
  readonly recordingMetaMerged: (
    id: string,
    patch: Record<string, unknown>
  ) => Effect.Effect<void, ProductDbError>;
}

export class RecordingStore extends Context.Tag('desktop/RecordingStore')<
  RecordingStore,
  RecordingStoreApi
>() {}
