/**
 * The note-side input a skill run feeds the model implements the server
 * behavior over the product store. Transcript lines
 * are `Label: text`, chronological (startTimeMs, then segmentOrder), final
 * segments only when scoped to a recording or on the naming lane; the speaker
 * key falls back to You/Them (no local recording-speaker renames — that lane
 * is cloud-only). Attendee emails never enter a prompt: there are no local
 * events at all (calendar is cloud-only), so `linkedEvent` is always null.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { SkillNoteInput, SkillRunContext } from '@prismical/ai-prompts';
import * as schema from '../../infra/product-db/schema';
import type { LocalDb } from './wire';

export type NoteRow = typeof schema.note.$inferSelect;

export interface LoadNoteInputOptions {
  readonly includeTranscript: boolean;
  /** Scope the transcript to one recording (the Enhance lane). */
  readonly recordingId?: string;
  /** Final, completed-recording segments only (the naming lane). */
  readonly finalOnly?: boolean;
  /** Live editor markdown the client sent; `''` is a real (empty) override. */
  readonly noteMarkdownOverride?: string;
}

const speakerLabel = (key: string): string => {
  if (key === 'you') return 'You';
  if (key === 'them') return 'Them';
  if (key.startsWith('dz:')) {
    const n = Number(key.slice(3));
    return Number.isFinite(n) ? `Speaker ${n + 1}` : 'Speaker';
  }
  return key;
};

export const selectNoteRow = async (db: LocalDb, noteId: string): Promise<NoteRow | undefined> => {
  const rows = await db
    .select()
    .from(schema.note)
    .where(and(eq(schema.note.id, noteId), isNull(schema.note.deletedAt)))
    .limit(1);
  return rows[0];
};

/** The markdown the model reads: the live override, else the stored projection. */
export const noteTextOf = (row: NoteRow, override: string | undefined): string =>
  override ?? row.contentMarkdown ?? row.contentText ?? '';

export async function loadNoteInput(
  db: LocalDb,
  noteId: string,
  opts: LoadNoteInputOptions
): Promise<SkillNoteInput | null> {
  const row = await selectNoteRow(db, noteId);
  if (row === undefined || row.trashedAt !== null) return null;
  const input: SkillNoteInput = {
    noteId: row.id,
    title: row.title,
    noteText: noteTextOf(row, opts.noteMarkdownOverride),
  };
  if (!opts.includeTranscript) return input;

  const scope = [
    eq(schema.recording.noteId, noteId),
    isNull(schema.transcriptSegment.deletedAt),
    isNull(schema.recording.deletedAt),
  ];
  if (opts.finalOnly) {
    scope.push(
      eq(schema.transcriptSegment.isFinal, true),
      eq(schema.recording.status, 'completed'),
      sql`length(trim(${schema.transcriptSegment.text})) > 0`
    );
  }
  if (opts.recordingId !== undefined) {
    scope.push(
      eq(schema.recording.id, opts.recordingId),
      eq(schema.transcriptSegment.isFinal, true)
    );
  }
  const segments = await db
    .select({
      recordingId: schema.transcriptSegment.recordingId,
      speaker: schema.transcriptSegment.speaker,
      text: schema.transcriptSegment.text,
    })
    .from(schema.transcriptSegment)
    .innerJoin(schema.recording, eq(schema.recording.id, schema.transcriptSegment.recordingId))
    .where(and(...scope))
    // startTimeMs first: finalize rows live in a reserved segmentOrder space far above live rows.
    .orderBy(asc(schema.transcriptSegment.startTimeMs), asc(schema.transcriptSegment.segmentOrder));

  if (segments.length > 0) {
    input.transcript = segments.map(s => `${speakerLabel(s.speaker)}: ${s.text}`).join('\n');
    // Set ONLY when segments exist — the NO_TRANSCRIPT guard keys on it.
    if (opts.recordingId !== undefined) input.recordingId = opts.recordingId;
  }

  // Context signals: the scoped recording, else the
  // note's most recent one. No local events → linkedEvent is definitively null.
  const recordingRows = await db
    .select({
      captureMode: schema.recording.captureMode,
      meta: schema.recording.meta,
    })
    .from(schema.recording)
    .where(
      and(
        eq(schema.recording.noteId, noteId),
        isNull(schema.recording.deletedAt),
        ...(opts.recordingId !== undefined ? [eq(schema.recording.id, opts.recordingId)] : [])
      )
    )
    .orderBy(sql`${schema.recording.startedAt} DESC`)
    .limit(1);
  const recording = recordingRows[0];
  const detected = (recording?.meta as { detectedSpeakerCount?: unknown } | null)
    ?.detectedSpeakerCount;
  const context: SkillRunContext = {
    ...(recording ? { captureMode: recording.captureMode } : {}),
    ...(typeof detected === 'number' ? { detectedSpeakerCount: detected } : {}),
    linkedEvent: null,
  };
  input.context = context;
  return input;
}

export const skillInputIsEmpty = (input: SkillNoteInput): boolean =>
  input.noteText.trim().length === 0 && (input.transcript ?? '').trim().length === 0;

/**
 * A recording row left in `recording` with no activity for this long is an
 * interrupted capture (crash, force-quit, a drain that gave up), not one still
 * landing segments — core never blocks on live capture at all, it blocks only
 * on a post-stop finalize job, and the local analogue of that window is the
 * last chunks decoding right after stop. Past this window the row must not
 * 409 every transcript skill on the note forever.
 */
export const TRANSCRIPT_ACTIVITY_WINDOW_MS = 2 * 60_000;

/**
 * Whether a skill run must wait for a recording (409 TRANSCRIPT_FINALIZING):
 * locally a recording is "finalizing" while its status is still `recording`
 * AND it showed activity recently (the row stamp or its newest segment).
 * Scoped runs check that recording; whole-note runs check every recording of
 * the note.
 */
export async function transcriptBlocker(
  db: LocalDb,
  noteId: string,
  recordingId: string | undefined,
  now: number = Date.now()
): Promise<{ recordingId: string; phase: 'running' } | null> {
  const rows = await db
    .select({
      id: schema.recording.id,
      status: schema.recording.status,
      startedAt: schema.recording.startedAt,
      updatedAt: schema.recording.updatedAt,
      lastSegmentAt: sql<string | null>`(SELECT max(${schema.transcriptSegment.createdAt}) FROM ${schema.transcriptSegment} WHERE ${schema.transcriptSegment.recordingId} = ${schema.recording.id})`,
    })
    .from(schema.recording)
    .where(
      and(
        eq(schema.recording.noteId, noteId),
        isNull(schema.recording.deletedAt),
        ...(recordingId !== undefined ? [eq(schema.recording.id, recordingId)] : [])
      )
    );
  const stamp = (value: string | null): number => {
    const ms = value === null ? Number.NaN : Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  };
  const blocking = rows.find(row => {
    if (row.status !== 'recording') return false;
    const lastActivity = Math.max(stamp(row.updatedAt), stamp(row.startedAt), stamp(row.lastSegmentAt));
    return now - lastActivity < TRANSCRIPT_ACTIVITY_WINDOW_MS;
  });
  return blocking ? { recordingId: blocking.id, phase: 'running' } : null;
}
