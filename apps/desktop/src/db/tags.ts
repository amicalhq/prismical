import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { tags, noteTags, type Tag, type NewTag } from "./schema";

type DB = LibSQLDatabase<Record<string, unknown>>;

// Treat user-typed `%`, `_`, `\` as literals in LIKE patterns. Pair with
// `ESCAPE '\'` in the query.
function escapeLike(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
}

export interface ListTagsOptions {
  sortBy?: "createdAt" | "name";
  search?: string;
  limit?: number;
  offset?: number;
}

export async function createTag(
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
  if (search) {
    const pattern = `%${escapeLike(search.toLowerCase())}%`;
    q = q.where(sql`${tags.name} LIKE ${pattern} ESCAPE '\\'`);
  }
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

  const searchPattern = search
    ? `%${escapeLike(search.toLowerCase())}%`
    : undefined;
  const rows = await db
    .select({
      tag: tags,
      noteCount: sql<number>`COUNT(${noteTags.tagId})`.as("note_count"),
    })
    .from(tags)
    .leftJoin(noteTags, eq(noteTags.tagId, tags.id))
    .where(
      searchPattern
        ? sql`${tags.name} LIKE ${searchPattern} ESCAPE '\\'`
        : undefined,
    )
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
  return await db.transaction(async (tx) => {
    const [{ count }] = await tx
      .select({ count: sql<number>`COUNT(*)` })
      .from(noteTags)
      .where(eq(noteTags.tagId, id));
    await tx.delete(tags).where(eq(tags.id, id));
    return { detachedNoteCount: Number(count) };
  });
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
