import { and, eq, isNull, sql } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { folder, note } from '../../infra/product-db/schema';
import type { LocalDb } from './wire';

/** The database file is the local ownership boundary; assignments require a live row. */
export const liveFolderExists = (db: Pick<LocalDb, 'select'>, id: string): boolean =>
  db
    .select({ id: folder.id })
    .from(folder)
    .where(and(eq(folder.id, id), isNull(folder.deletedAt)))
    .get() !== undefined;

/** Called inside the write transaction. Include tombstones in the cycle walk, as core does. */
export function validFolderParent(
  db: Pick<LocalDb, 'select' | 'get'>,
  id: string | undefined,
  parentId: unknown
): boolean {
  if (parentId === undefined || parentId === null) return true;
  if (typeof parentId !== 'string' || !liveFolderExists(db, parentId)) return false;
  if (id === undefined) return true;
  const cycle = db.get(sql`
    with recursive ancestors(id, parent_id) as (
      select id, parent_id from folder where id = ${parentId}
      union
      select f.id, f.parent_id from folder f join ancestors a on f.id = a.parent_id
    )
    select id from ancestors where id = ${id} limit 1
  `);
  return cycle === undefined;
}

/** Soft deletion does not clear references. Detach even trashed/deleted notes in the same tx. */
export function detachFolderContents(db: Pick<LocalDb, 'update'>, id: string, now: string): void {
  const advance = (column: SQLiteColumn) =>
    sql<string>`max(${now}, strftime('%Y-%m-%dT%H:%M:%fZ', ${column}, '+0.001 seconds'))`;
  db.update(note)
    .set({
      folderId: null,
      updatedAt: advance(note.updatedAt),
      metadataUpdatedAt: advance(note.metadataUpdatedAt),
    })
    .where(eq(note.folderId, id))
    .run();
  db.update(folder)
    .set({
      parentId: null,
      updatedAt: advance(folder.updatedAt),
    })
    .where(eq(folder.parentId, id))
    .run();
}
