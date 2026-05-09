import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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
  data: Pick<NewFolder, "name"> & { parentId?: number | null; isFavorite?: boolean },
): Promise<Folder> {
  const now = new Date();
  const [row] = await db
    .insert(folders)
    .values({
      name: data.name,
      parentId: data.parentId ?? null,
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

export async function getFolderByNameAndParent(
  db: DB,
  name: string,
  parentId: number | null,
): Promise<Folder | null> {
  const [row] = await db
    .select()
    .from(folders)
    .where(
      and(
        sql`LOWER(${folders.name}) = LOWER(${name})`,
        parentId === null
          ? isNull(folders.parentId)
          : eq(folders.parentId, parentId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listFolders(
  db: DB,
  opts: ListFoldersOptions = {},
): Promise<Folder[]> {
  const { sortBy = "createdAt", search, limit, offset } = opts;
  const order = sortBy === "name" ? sql`LOWER(${folders.name}) ASC` : desc(folders.createdAt);

  let q = db.select().from(folders).orderBy(order).$dynamic();
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    q = q.where(sql`LOWER(${folders.name}) LIKE LOWER(${pattern}) ESCAPE '\\'`);
  }
  if (limit !== undefined) q = q.limit(limit);
  if (offset !== undefined) q = q.offset(offset);
  return await q;
}

export async function listAllForTree(db: DB): Promise<Folder[]> {
  // Ordering puts top-level rows (parent_id NULL) first, then groups siblings
  // by direct parent_id, then sorts each group by name. NOTE: this is not a
  // depth-ordered traversal — it interleaves descendants by their direct
  // parent's id, not by ancestry. Callers building a tree should walk
  // parent_id pointers themselves; this query exists to fetch every row in
  // one round-trip, not to provide a guaranteed pre-order.
  return await db
    .select()
    .from(folders)
    .orderBy(
      sql`(${folders.parentId} IS NOT NULL)`,
      sql`COALESCE(${folders.parentId}, 0)`,
      asc(folders.name),
    );
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
  const order = sortBy === "name" ? sql`LOWER(${folders.name}) ASC` : desc(folders.createdAt);

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

// Accepts both a top-level DB and a SQLiteTransaction; both expose the
// drizzle query API but their concrete TS types differ on `batch`.
type DBOrTx = Pick<DB, "select" | "delete">;

// Belt-and-suspenders cap: with the visited-set cycle guard the BFS is
// already O(folders), but we don't currently have a schema-level CHECK or
// app-level guard preventing a cycle in `folders.parentId`. If something
// upstream slips a cycle in, we want this loop to surface the bug as a
// thrown error rather than hold the SQLite write lock indefinitely.
const MAX_SUBTREE_BFS_LEVELS = 1024;

/**
 * BFS of folders.parentId pointing at descendants of `rootId`. Returns
 * [rootId, ...descendants] in discovery order, or [] if `rootId` doesn't
 * exist. Cycle-safe via a visited Set.
 */
export async function subtreeIds(
  db: DBOrTx,
  rootId: number,
): Promise<number[]> {
  const [root] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(eq(folders.id, rootId))
    .limit(1);
  if (!root) return [];
  const visited = new Set<number>([rootId]);
  let frontier = [rootId];
  for (let level = 0; level < MAX_SUBTREE_BFS_LEVELS; level++) {
    const rows = await db
      .select({ id: folders.id })
      .from(folders)
      .where(inArray(folders.parentId, frontier));
    const next: number[] = [];
    for (const row of rows) {
      if (visited.has(row.id)) continue;
      visited.add(row.id);
      next.push(row.id);
    }
    if (next.length === 0) return Array.from(visited);
    frontier = next;
  }
  throw new Error(
    `Folder subtree BFS exceeded ${MAX_SUBTREE_BFS_LEVELS} levels — likely a parent_id cycle anchored at folder ${rootId}`,
  );
}

export interface FolderDeletePreview {
  /** Subfolders below `rootId` (does not include the root). */
  subfolderCount: number;
  /** Notes inside the root or any descendant. */
  noteCount: number;
}

export async function getFolderDeletePreview(
  db: DB,
  rootId: number,
): Promise<FolderDeletePreview> {
  const ids = await subtreeIds(db, rootId);
  if (ids.length === 0) {
    return { subfolderCount: 0, noteCount: 0 };
  }
  const [{ count }] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(notes)
    .where(inArray(notes.folderId, ids));
  return {
    subfolderCount: ids.length - 1,
    noteCount: Number(count),
  };
}

// Raw shape returned by db.all() for the recursive CTE — all values are
// SQLite primitives (integers for timestamps and booleans, null for NULLs).
interface RawFolderWithCount {
  id: number;
  name: string;
  parent_id: number | null;
  is_favorite: number; // 0 | 1
  created_at: number; // Unix seconds
  updated_at: number; // Unix seconds
  note_count: number;
}

/**
 * Returns every folder with a recursive descendant note count — i.e. the
 * count includes notes in the folder itself AND in any nested subfolder.
 *
 * Implemented via a `WITH RECURSIVE` CTE because SQLite doesn't support
 * hierarchical aggregation through the regular query builder.
 */
export async function listWithRecursiveCounts(
  db: DB,
): Promise<FolderWithCount[]> {
  // The CTE walks the folder tree top-down:
  //   anchor:    seed with every folder as its own root
  //   recursive: extend by following parent_id upward so that each
  //              descendant row carries the ancestor's root_id.
  // Then we join notes to count per (root_id) and LEFT JOIN back to
  // folders to get 0 for folders with no notes anywhere in their subtree.
  //
  // Cycle safety: there is no schema CHECK or app-level guard preventing
  // a cycle in folders.parent_id (same caveat noted on `subtreeIds`). The
  // recursive step uses UNION ALL — a cycle would expand forever, but
  // SQLite caps recursion at SQLITE_MAX_RECURSION_DEPTH (1000), so the
  // failure mode is a thrown "maximum recursion depth exceeded" rather
  // than a hang. That's acceptable for a local desktop DB.
  const rows = await db.all<RawFolderWithCount>(sql`
    WITH RECURSIVE descendants(root_id, folder_id) AS (
      SELECT id AS root_id, id AS folder_id FROM folders
      UNION ALL
      SELECT d.root_id, f.id
      FROM folders f
      INNER JOIN descendants d ON f.parent_id = d.folder_id
    )
    SELECT
      f.id,
      f.name,
      f.parent_id,
      f.is_favorite,
      f.created_at,
      f.updated_at,
      COUNT(n.id) AS note_count
    FROM folders f
    LEFT JOIN descendants d ON d.root_id = f.id
    LEFT JOIN notes n ON n.folder_id = d.folder_id
    GROUP BY f.id
  `);

  return rows.map(
    (r): FolderWithCount => ({
      id: r.id,
      name: r.name,
      parentId: r.parent_id,
      isFavorite: r.is_favorite === 1,
      createdAt: new Date(r.created_at * 1000),
      updatedAt: new Date(r.updated_at * 1000),
      noteCount: Number(r.note_count),
    }),
  );
}

/**
 * Returns the count of notes that have no folder (folderId IS NULL).
 * These appear as the "Unfiled" pseudo-row in the notes browser.
 */
export async function countUnfiled(db: DB): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(notes)
    .where(isNull(notes.folderId));
  return Number(count);
}

export interface FolderDeleteResult {
  /** Subfolders deleted under the root, not including the root itself. */
  deletedSubfolderCount: number;
  /** Notes deleted across the entire subtree (root + descendants). */
  deletedNoteCount: number;
}

export async function deleteFolder(
  db: DB,
  rootId: number,
): Promise<FolderDeleteResult> {
  return await db.transaction(async (tx) => {
    const ids = await subtreeIds(tx, rootId);
    if (ids.length === 0) {
      return { deletedSubfolderCount: 0, deletedNoteCount: 0 };
    }
    const [{ count }] = await tx
      .select({ count: sql<number>`COUNT(*)` })
      .from(notes)
      .where(inArray(notes.folderId, ids));
    // Order is load-bearing: notes.folderId is ON DELETE SET NULL, so if we
    // deleted folders first the cascade would null out every contained
    // note's folder_id and the subsequent inArray(notes.folderId, …) match
    // would find nothing — those notes would survive as unfiled. Delete
    // notes first; FK cascades on note_artifacts / note_tags / yjs_updates
    // / meetings fire off the note ids regardless of folder existence.
    await tx.delete(notes).where(inArray(notes.folderId, ids));
    await tx.delete(folders).where(inArray(folders.id, ids));
    return {
      deletedSubfolderCount: ids.length - 1,
      deletedNoteCount: Number(count),
    };
  });
}
