import { eq, desc, asc, like, and, inArray, isNull, sql, lte, lt, notInArray } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { db } from "./index";
import {
  notes,
  events,
  yjsUpdates,
  noteTags,
  noteSnapshots,
  type Note,
  type NewNote,
  type YjsUpdate,
} from "./schema";

// Create a new note
export async function createNote(
  data: Omit<NewNote, "id" | "createdAt" | "updatedAt" | "lastAccessedAt">,
) {
  const now = new Date();

  const newNote: NewNote = {
    ...data,
    createdAt: now,
    updatedAt: now,
  };

  const result = await db.insert(notes).values(newNote).returning();
  return result[0];
}

// Shape returned from queries that JOIN notes with events
export interface NoteWithEvent extends Note {
  eventData?: {
    eventId: string;
    title: string;
    calendarColor: string;
    meetingUrl?: string;
    calendarEventUrl?: string;
    startAt: Date;
    endAt: Date;
    isAllDay: boolean;
  } | null;
}

function toNoteWithEvent(row: {
  notes: Note;
  events: typeof events.$inferSelect | null;
}): NoteWithEvent {
  const { notes: note, events: event } = row;
  return {
    ...note,
    eventData: event
      ? {
          eventId: event.id,
          title: event.title,
          calendarColor: event.calendarColor,
          meetingUrl: event.meetingUrl ?? undefined,
          calendarEventUrl: event.calendarEventUrl ?? undefined,
          startAt: event.startAt,
          endAt: event.endAt,
          isAllDay: event.isAllDay,
        }
      : null,
  };
}

// Get all notes with optional filtering and sorting
export async function getNotes(
  options: {
    limit?: number;
    offset?: number;
    sortBy?: "title" | "updatedAt" | "createdAt";
    sortOrder?: "asc" | "desc";
    search?: string;
    tagId?: number;             // legacy single-tag filter
    tagIds?: number[];          // NEW: AND-mode multi-tag filter
    folderId?: number | null;   // legacy single-folder filter; null = unfiled
    folderIds?: number[];       // NEW: IN-mode multi-folder filter
  } = {},
): Promise<NoteWithEvent[]> {
  const {
    limit = 50,
    offset = 0,
    sortBy = "updatedAt",
    sortOrder = "desc",
    search,
    tagId,
    tagIds,
    folderId,
    folderIds,
  } = options;

  // Resolve tag filter. Precedence:
  //   - tagIds non-empty   → AND-filter on those ids
  //   - tagIds empty / undefined AND tagId set → legacy single-tag filter
  //   - both empty / undefined → no tag filter
  // Note: passing { tagId: 5, tagIds: [] } falls back to tagId=5. Callers
  // that want to clear a tag filter should pass neither field rather than
  // an explicit empty array alongside a legacy tagId. Once every caller
  // uses tagIds, tagId can be removed.
  let restrictToNoteIds: number[] | null = null;
  const effectiveTagIds =
    tagIds && tagIds.length > 0
      ? tagIds
      : tagId !== undefined
        ? [tagId]
        : null;

  if (effectiveTagIds !== null) {
    const rows = await db
      .select({ id: noteTags.noteId })
      .from(noteTags)
      .where(inArray(noteTags.tagId, effectiveTagIds))
      .groupBy(noteTags.noteId)
      .having(sql`COUNT(DISTINCT ${noteTags.tagId}) = ${effectiveTagIds.length}`);
    restrictToNoteIds = rows.map((r) => r.id);
    if (restrictToNoteIds.length === 0) return [];
  }

  // Build query with LEFT JOIN
  let query = db
    .select()
    .from(notes)
    .leftJoin(events, eq(notes.eventId, events.id));

  // Apply filters
  const conditions = [];
  if (search) {
    conditions.push(like(notes.title, `%${search}%`));
  }
  if (restrictToNoteIds !== null) {
    conditions.push(inArray(notes.id, restrictToNoteIds));
  }
  if (folderIds && folderIds.length > 0) {
    conditions.push(inArray(notes.folderId, folderIds));
  } else if (folderId !== undefined) {
    conditions.push(
      folderId === null ? isNull(notes.folderId) : eq(notes.folderId, folderId),
    );
  }

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as any;
  }

  // Apply sorting
  const sortColumn = notes[sortBy];
  const orderFn = sortOrder === "asc" ? asc : desc;
  query = query.orderBy(orderFn(sortColumn)) as any;

  // Apply pagination
  query = query.limit(limit).offset(offset) as any;

  const rows = await query;
  return rows.map(toNoteWithEvent);
}

// Get note by ID
export async function getNoteById(id: number): Promise<NoteWithEvent | null> {
  const result = await db
    .select()
    .from(notes)
    .leftJoin(events, eq(notes.eventId, events.id))
    .where(eq(notes.id, id));
  if (!result[0]) return null;
  return toNoteWithEvent(result[0]);
}

// Get multiple notes by ID (single query). Order is not preserved — callers
// that care should reorder client-side. Missing IDs are silently dropped.
export async function getNotesByIds(ids: number[]): Promise<NoteWithEvent[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(notes)
    .leftJoin(events, eq(notes.eventId, events.id))
    .where(inArray(notes.id, ids));
  return rows.map(toNoteWithEvent);
}

// Get note by event ID (FK column)
export async function getNoteByEventId(
  eventId: string,
): Promise<NoteWithEvent | null> {
  const result = await db
    .select()
    .from(notes)
    .leftJoin(events, eq(notes.eventId, events.id))
    .where(eq(notes.eventId, eventId));
  if (!result[0]) return null;
  return toNoteWithEvent(result[0]);
}

// Update note
export async function updateNote(
  id: number,
  data: Partial<Omit<Note, "id" | "createdAt" | "docName">>,
) {
  const updateData = {
    ...data,
    updatedAt: new Date(),
  };

  const result = await db
    .update(notes)
    .set(updateData)
    .where(eq(notes.id, id))
    .returning();

  return result[0] || null;
}

// Delete note
export async function deleteNote(id: number) {
  // Delete the note (yjs updates and metadata will be cascade deleted)
  const result = await db.delete(notes).where(eq(notes.id, id)).returning();
  return result[0] || null;
}

// YJS Updates operations

type DB = LibSQLDatabase<Record<string, unknown>>;

// Save a YJS update to the database
export async function saveYjsUpdate(
  db: DB,
  noteId: number,
  update: Uint8Array,
) {
  // Convert Uint8Array to Buffer for storage
  const bufferUpdate = Buffer.from(update);

  // Insert into yjs_updates table
  await db.insert(yjsUpdates).values({
    noteId,
    updateData: bufferUpdate,
  });
}

// Load all YJS updates for a note
export async function loadYjsUpdates(
  db: DB,
  noteId: number,
): Promise<Uint8Array[]> {
  const updates = await db
    .select()
    .from(yjsUpdates)
    .where(eq(yjsUpdates.noteId, noteId))
    .orderBy(asc(yjsUpdates.id));

  // Convert Buffer to Uint8Array
  return updates.map((u: YjsUpdate) => {
    return new Uint8Array(u.updateData as Buffer);
  });
}

// Get all unique note IDs that have updates
export async function getUniqueNoteIds(db: DB): Promise<number[]> {
  const result = await db
    .select({ noteId: yjsUpdates.noteId })
    .from(yjsUpdates)
    .groupBy(yjsUpdates.noteId);

  return result.map((r: { noteId: number }) => r.noteId);
}

// Get all YJS updates for a specific note
export async function getYjsUpdatesByNoteId(
  db: DB,
  noteId: number,
): Promise<YjsUpdate[]> {
  return await db
    .select()
    .from(yjsUpdates)
    .where(eq(yjsUpdates.noteId, noteId))
    .orderBy(asc(yjsUpdates.id));
}

// Compact YJS updates up to a watermark id (race-safe).
// Deletes rows with id <= maxId for the note and inserts the compacted update
// in a single transaction. Any rows inserted after maxId (concurrent writes)
// are preserved.
export async function compactUpToId(
  db: DB,
  noteId: number,
  maxId: number,
  compactedUpdate: Uint8Array,
): Promise<void> {
  const bufferUpdate = Buffer.from(compactedUpdate);

  await db.transaction(async (tx) => {
    // Delete only rows up to the watermark — concurrent tail rows survive
    await tx
      .delete(yjsUpdates)
      .where(and(eq(yjsUpdates.noteId, noteId), lte(yjsUpdates.id, maxId)));

    // Insert the compacted update
    await tx.insert(yjsUpdates).values({
      noteId,
      updateData: bufferUpdate,
    });
  });
}

// Replace notes.content with the current markdown projection.
// notes.content is the one-way markdown sidecar (PRSM-56).
export async function setNoteMarkdown(
  db: DB,
  noteId: number,
  markdown: string,
): Promise<void> {
  await db
    .update(notes)
    .set({
      content: markdown,
      updatedAt: new Date(),
    })
    .where(eq(notes.id, noteId));
}

// Snapshot helpers — PRSM-56 §11.6

export type NoteSnapshotKind = "manual" | "auto" | "skill-accept";

export interface SaveNoteSnapshotArgs {
  noteId: number;
  kind: NoteSnapshotKind;
  ydocState: Uint8Array;
  markdown: string;
  label?: string | null;
  createdBy?: string | null;
}

// Persist a self-contained snapshot of a note's Yjs state at this moment.
// Stores the full encoded state (not a marker on yjs_updates), so compaction
// of the live log never invalidates this row. See PRSM-56 §11.6.
export async function saveNoteSnapshot(
  db: DB,
  args: SaveNoteSnapshotArgs,
): Promise<number> {
  const [row] = await db
    .insert(noteSnapshots)
    .values({
      noteId: args.noteId,
      kind: args.kind,
      label: args.label ?? null,
      ydocState: Buffer.from(args.ydocState),
      markdown: args.markdown,
      createdBy: args.createdBy ?? null,
    })
    .returning({ id: noteSnapshots.id });
  return row.id;
}

export interface PruneOpts {
  /**
   * Delete non-protected snapshots older than this many days.
   * `0` or `undefined` disables the age axis.
   */
  maxAgeDays?: number;
  /**
   * Cap the per-note non-protected snapshot count at this number.
   * Survivors are the newest N by `createdAt`. `0` or `undefined`
   * disables the count axis.
   */
  maxCount?: number;
  /**
   * Kinds that are NEVER pruned by either axis. Default: `["manual"]`.
   */
  protectKinds?: NoteSnapshotKind[];
}

// Default retention. A future user-facing setting in `app_settings` will
// override these at the call site. PRSM-56 §11.6 retention.
export const DEFAULT_SNAPSHOT_RETENTION: Required<PruneOpts> = {
  maxAgeDays: 30,
  maxCount: 50,
  protectKinds: ["manual"],
};

// Two-axis retention: delete non-protected snapshots older than maxAgeDays,
// then cap the per-note non-protected count at maxCount (newest survive).
// Manual snapshots (default protectKinds) are NEVER pruned.
export async function pruneNoteSnapshots(
  db: DB,
  noteId: number,
  opts: PruneOpts = {},
): Promise<{ deleted: number }> {
  const policy: Required<PruneOpts> = {
    maxAgeDays: opts.maxAgeDays ?? DEFAULT_SNAPSHOT_RETENTION.maxAgeDays,
    maxCount: opts.maxCount ?? DEFAULT_SNAPSHOT_RETENTION.maxCount,
    protectKinds:
      opts.protectKinds ?? DEFAULT_SNAPSHOT_RETENTION.protectKinds,
  };

  return db.transaction(async (tx) => {
    let deleted = 0;

    // Axis 1: age cutoff (non-protected only).
    if (policy.maxAgeDays > 0) {
      const cutoff = new Date(Date.now() - policy.maxAgeDays * 86_400_000);
      const res = await tx
        .delete(noteSnapshots)
        .where(
          and(
            eq(noteSnapshots.noteId, noteId),
            notInArray(noteSnapshots.kind, policy.protectKinds),
            lt(noteSnapshots.createdAt, cutoff),
          ),
        )
        .returning({ id: noteSnapshots.id });
      deleted += res.length;
    }

    // Axis 2: count cap (non-protected only). Survivors = newest N; delete
    // everything else within the non-protected set.
    if (policy.maxCount > 0) {
      const survivors = await tx
        .select({ id: noteSnapshots.id })
        .from(noteSnapshots)
        .where(
          and(
            eq(noteSnapshots.noteId, noteId),
            notInArray(noteSnapshots.kind, policy.protectKinds),
          ),
        )
        .orderBy(desc(noteSnapshots.createdAt))
        .limit(policy.maxCount);
      const survivorIds = survivors.map((s) => s.id);

      // When the non-protected set is empty (no rows survive the LIMIT N
      // query), survivorIds is []. Without this guard, notInArray(id, [])
      // evaluates to TRUE in drizzle and we'd delete every non-protected
      // row — the exact opposite of what we want.
      if (survivorIds.length > 0) {
        const res = await tx
          .delete(noteSnapshots)
          .where(
            and(
              eq(noteSnapshots.noteId, noteId),
              notInArray(noteSnapshots.kind, policy.protectKinds),
              notInArray(noteSnapshots.id, survivorIds),
            ),
          )
          .returning({ id: noteSnapshots.id });
        deleted += res.length;
      }
    }

    return { deleted };
  });
}
