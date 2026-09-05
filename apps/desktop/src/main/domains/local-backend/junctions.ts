/**
 * The note-tags junction lane implements the
 * server sync dialect over the product store. Composite
 * key (noteId, tagId); wire rows carry NO id column; the POST echo is EXACTLY
 * `{noteId, tagId}` (201, timestamp-less) and revives a
 * tombstoned link (the ONE revive in the dialect); DELETE at /:noteId/:tagId
 * tombstones; both parents must exist AND be live or the link 404s (no-leak).
 */
import { and, asc, eq, gt, isNull, type SQL } from 'drizzle-orm';
import { NoteTagRequestSchema } from '@prismical/api-contracts/apps/v1';
import * as schema from '../../infra/product-db/schema';
import {
  invalidRequest,
  notFound,
  ok,
  parseTimestampMs,
  queryFlag,
  type LocalDb,
  type RouteResult,
} from './wire';

const linkWhere = (noteId: string, tagId: string) =>
  and(eq(schema.noteTag.noteId, noteId), eq(schema.noteTag.tagId, tagId));

/** GET /apps/v1/me/note-tags?since&includeDeleted — delta over the junction rows. */
export const listNoteTags = async (
  db: LocalDb,
  query: Record<string, string>
): Promise<RouteResult> => {
  const conds: SQL[] = [];
  const sinceMs = parseTimestampMs(query.since);
  if (sinceMs !== null) conds.push(gt(schema.noteTag.updatedAt, new Date(sinceMs).toISOString()));
  if (!queryFlag(query.includeDeleted)) conds.push(isNull(schema.noteTag.deletedAt));
  const rows = await db
    .select({
      noteId: schema.noteTag.noteId,
      tagId: schema.noteTag.tagId,
      addedAt: schema.noteTag.addedAt,
      updatedAt: schema.noteTag.updatedAt,
      deletedAt: schema.noteTag.deletedAt,
    })
    .from(schema.noteTag)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(asc(schema.noteTag.updatedAt), asc(schema.noteTag.noteId), asc(schema.noteTag.tagId));
  return ok({ results: rows });
};

const liveNote = async (db: LocalDb, noteId: string): Promise<boolean> => {
  const rows = await db
    .select({ deletedAt: schema.note.deletedAt })
    .from(schema.note)
    .where(eq(schema.note.id, noteId))
    .limit(1);
  return rows.length > 0 && rows[0].deletedAt === null;
};

const liveTag = async (db: LocalDb, tagId: string): Promise<boolean> => {
  const rows = await db
    .select({ deletedAt: schema.tag.deletedAt })
    .from(schema.tag)
    .where(eq(schema.tag.id, tagId))
    .limit(1);
  return rows.length > 0 && rows[0].deletedAt === null;
};

/** POST /apps/v1/me/note-tags — upsert-with-revive; 201 with the bare key echo. */
export const createNoteTag = async (db: LocalDb, body: unknown): Promise<RouteResult> => {
  const parsed = NoteTagRequestSchema.safeParse(body);
  if (!parsed.success) return invalidRequest();
  const { noteId, tagId } = parsed.data;
  if (!(await liveNote(db, noteId)) || !(await liveTag(db, tagId))) return notFound();
  const now = new Date().toISOString();
  const existing = await db
    .select({ noteId: schema.noteTag.noteId })
    .from(schema.noteTag)
    .where(linkWhere(noteId, tagId))
    .limit(1);
  if (existing.length > 0) {
    // Revive (or refresh) the link; addedAt is preserved (junctions.ts parity).
    await db
      .update(schema.noteTag)
      .set({ deletedAt: null, updatedAt: now })
      .where(linkWhere(noteId, tagId));
  } else {
    await db
      .insert(schema.noteTag)
      .values({ noteId, tagId, addedAt: now, updatedAt: now, deletedAt: null });
  }
  return ok({ noteId, tagId }, 201);
};

/** DELETE /apps/v1/me/note-tags/:noteId/:tagId — tombstone; replay → 404 (ack). */
export const deleteNoteTag = async (
  db: LocalDb,
  noteId: string,
  tagId: string
): Promise<RouteResult> => {
  const existing = await db
    .select({ deletedAt: schema.noteTag.deletedAt })
    .from(schema.noteTag)
    .where(linkWhere(noteId, tagId))
    .limit(1);
  if (existing.length === 0 || existing[0].deletedAt !== null) return notFound();
  const now = new Date().toISOString();
  await db
    .update(schema.noteTag)
    .set({ deletedAt: now, updatedAt: now })
    .where(linkWhere(noteId, tagId));
  return ok(undefined, 204);
};
