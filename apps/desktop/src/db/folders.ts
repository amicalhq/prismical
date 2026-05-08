import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { folders, notes, type Folder, type NewFolder } from "./schema";

type DB = LibSQLDatabase<Record<string, unknown>>;

function escapeLike(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
}

export interface ListFoldersOptions {
  sortBy?: "createdAt" | "name";
  search?: string;
  limit?: number;
  offset?: number;
}

export async function createFolder(
  db: DB,
  data: Pick<NewFolder, "name"> & { isFavorite?: boolean },
): Promise<Folder> {
  const now = new Date();
  const [row] = await db
    .insert(folders)
    .values({
      name: data.name,
      isFavorite: data.isFavorite ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

export async function getFolderById(db: DB, id: number): Promise<Folder | null> {
  const [row] = await db.select().from(folders).where(eq(folders.id, id)).limit(1);
  return row ?? null;
}

export async function getFolderByLowerName(
  db: DB,
  name: string,
): Promise<Folder | null> {
  const [row] = await db
    .select()
    .from(folders)
    .where(sql`LOWER(${folders.name}) = LOWER(${name})`)
    .limit(1);
  return row ?? null;
}

export async function listFolders(
  db: DB,
  opts: ListFoldersOptions = {},
): Promise<Folder[]> {
  const { sortBy = "createdAt", search, limit, offset } = opts;
  const order = sortBy === "name" ? asc(folders.name) : desc(folders.createdAt);

  let q = db.select().from(folders).orderBy(order).$dynamic();
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    q = q.where(sql`LOWER(${folders.name}) LIKE LOWER(${pattern}) ESCAPE '\\'`);
  }
  if (limit !== undefined) q = q.limit(limit);
  if (offset !== undefined) q = q.offset(offset);
  return await q;
}

export async function listFavoriteFolders(db: DB): Promise<Folder[]> {
  return await db
    .select()
    .from(folders)
    .where(eq(folders.isFavorite, true))
    .orderBy(desc(folders.createdAt));
}

export interface FolderWithCount extends Folder {
  noteCount: number;
}

export async function listAllFoldersWithCounts(
  db: DB,
  opts: ListFoldersOptions = {},
): Promise<FolderWithCount[]> {
  const { sortBy = "createdAt", search } = opts;
  const order = sortBy === "name" ? asc(folders.name) : desc(folders.createdAt);

  const searchPattern = search ? `%${escapeLike(search)}%` : undefined;
  const rows = await db
    .select({
      folder: folders,
      noteCount: sql<number>`COUNT(${notes.id})`.as("note_count"),
    })
    .from(folders)
    .leftJoin(notes, eq(notes.folderId, folders.id))
    .where(
      searchPattern
        ? sql`LOWER(${folders.name}) LIKE LOWER(${searchPattern}) ESCAPE '\\'`
        : undefined,
    )
    .groupBy(folders.id)
    .orderBy(order);

  return rows.map((r) => ({ ...r.folder, noteCount: Number(r.noteCount) }));
}

export async function updateFolder(
  db: DB,
  id: number,
  patch: Partial<Pick<Folder, "name" | "isFavorite">>,
): Promise<Folder> {
  const [row] = await db
    .update(folders)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(folders.id, id))
    .returning();
  return row;
}

export async function deleteFolder(
  db: DB,
  id: number,
): Promise<{ detachedNoteCount: number }> {
  return await db.transaction(async (tx) => {
    const [{ count }] = await tx
      .select({ count: sql<number>`COUNT(*)` })
      .from(notes)
      .where(eq(notes.folderId, id));
    await tx.delete(folders).where(eq(folders.id, id));
    // ON DELETE SET NULL on notes.folderId cleans up the FK references automatically.
    return { detachedNoteCount: Number(count) };
  });
}
