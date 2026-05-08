import { eq, desc, asc, like, and, inArray, isNull, sql } from "drizzle-orm";
import { db } from "./index";
import {
  notes,
  events,
  yjsUpdates,
  noteTags,
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

// Save a YJS update to the database
export async function saveYjsUpdate(noteId: number, update: Uint8Array) {
  // Convert Uint8Array to Buffer for storage
  const bufferUpdate = Buffer.from(update);

  // Insert into yjs_updates table
  await db.insert(yjsUpdates).values({
    noteId,
    updateData: bufferUpdate,
  });
}

// Load all YJS updates for a note
export async function loadYjsUpdates(noteId: number): Promise<Uint8Array[]> {
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
export async function getUniqueNoteIds(): Promise<number[]> {
  const result = await db
    .select({ noteId: yjsUpdates.noteId })
    .from(yjsUpdates)
    .groupBy(yjsUpdates.noteId);

  return result.map((r: { noteId: number }) => r.noteId);
}

// Get all YJS updates for a specific note
export async function getYjsUpdatesByNoteId(
  noteId: number,
): Promise<YjsUpdate[]> {
  return await db
    .select()
    .from(yjsUpdates)
    .where(eq(yjsUpdates.noteId, noteId))
    .orderBy(asc(yjsUpdates.id));
}

// Replace all YJS updates with a compacted one (transactional)
export async function replaceYjsUpdates(
  noteId: number,
  compactedUpdate: Uint8Array,
): Promise<void> {
  const bufferUpdate = Buffer.from(compactedUpdate);

  await db.transaction(async (tx) => {
    // Delete all existing updates
    await tx.delete(yjsUpdates).where(eq(yjsUpdates.noteId, noteId));

    // Insert the compacted update
    await tx.insert(yjsUpdates).values({
      noteId,
      updateData: bufferUpdate,
    });
  });
}
