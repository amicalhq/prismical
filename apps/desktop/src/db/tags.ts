import { and, asc, desc, eq, like, sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { tags, noteTags, type Tag, type NewTag } from "./schema";

type DB = LibSQLDatabase<Record<string, unknown>>;

export interface ListTagsOptions {
  sortBy?: "createdAt" | "name";
  search?: string;
  limit?: number;
  offset?: number;
}

export async function insertTag(
  db: DB,
  data: Pick<NewTag, "name" | "color"> & { isFavorite?: boolean },
): Promise<Tag> {
  const now = new Date();
  const [row] = await db
    .insert(tags)
    .values({
      name: data.name,
      color: data.color,
      isFavorite: data.isFavorite ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

export async function getTagById(db: DB, id: number): Promise<Tag | null> {
  const [row] = await db.select().from(tags).where(eq(tags.id, id)).limit(1);
  return row ?? null;
}

export async function getTagByName(db: DB, name: string): Promise<Tag | null> {
  const [row] = await db.select().from(tags).where(eq(tags.name, name)).limit(1);
  return row ?? null;
}

export async function listTags(db: DB, opts: ListTagsOptions = {}): Promise<Tag[]> {
  const { sortBy = "createdAt", search, limit, offset } = opts;
  const order = sortBy === "name" ? asc(tags.name) : desc(tags.createdAt);

  let q = db.select().from(tags).orderBy(order).$dynamic();
  if (search) q = q.where(like(tags.name, `%${search.toLowerCase()}%`));
  if (limit !== undefined) q = q.limit(limit);
  if (offset !== undefined) q = q.offset(offset);
  return await q;
}

export async function listRecentTags(db: DB, limit: number): Promise<Tag[]> {
  return await db.select().from(tags).orderBy(desc(tags.createdAt)).limit(limit);
}

export async function listFavoriteTags(db: DB): Promise<Tag[]> {
  return await db
    .select()
    .from(tags)
    .where(eq(tags.isFavorite, true))
    .orderBy(desc(tags.createdAt));
}

export interface TagWithCount extends Tag {
  noteCount: number;
}

export async function listAllTagsWithCounts(
  db: DB,
  opts: ListTagsOptions = {},
): Promise<TagWithCount[]> {
  const { sortBy = "createdAt", search } = opts;
  const order = sortBy === "name" ? asc(tags.name) : desc(tags.createdAt);

  const rows = await db
    .select({
      tag: tags,
      noteCount: sql<number>`COUNT(${noteTags.tagId})`.as("note_count"),
    })
    .from(tags)
    .leftJoin(noteTags, eq(noteTags.tagId, tags.id))
    .where(search ? like(tags.name, `%${search.toLowerCase()}%`) : undefined)
    .groupBy(tags.id)
    .orderBy(order);

  return rows.map((r) => ({ ...r.tag, noteCount: Number(r.noteCount) }));
}

export async function listTagsByNoteId(db: DB, noteId: number): Promise<Tag[]> {
  const rows = await db
    .select({ tag: tags })
    .from(noteTags)
    .innerJoin(tags, eq(tags.id, noteTags.tagId))
    .where(eq(noteTags.noteId, noteId))
    .orderBy(desc(noteTags.addedAt));
  return rows.map((r) => r.tag);
}

export async function listNoteIdsByTagId(db: DB, tagId: number): Promise<number[]> {
  const rows = await db
    .select({ noteId: noteTags.noteId })
    .from(noteTags)
    .where(eq(noteTags.tagId, tagId));
  return rows.map((r) => r.noteId);
}

export async function updateTag(
  db: DB,
  id: number,
  patch: Partial<Pick<Tag, "name" | "color" | "isFavorite">>,
): Promise<Tag> {
  const [row] = await db
    .update(tags)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(tags.id, id))
    .returning();
  return row;
}

export async function deleteTag(db: DB, id: number): Promise<{ detachedNoteCount: number }> {
  const noteIds = await listNoteIdsByTagId(db, id);
  await db.delete(tags).where(eq(tags.id, id));
  return { detachedNoteCount: noteIds.length };
}

export async function attachTag(db: DB, noteId: number, tagId: number): Promise<void> {
  await db
    .insert(noteTags)
    .values({ noteId, tagId, addedAt: new Date() })
    .onConflictDoNothing();
}

export async function detachTag(db: DB, noteId: number, tagId: number): Promise<void> {
  await db
    .delete(noteTags)
    .where(and(eq(noteTags.noteId, noteId), eq(noteTags.tagId, tagId)));
}
