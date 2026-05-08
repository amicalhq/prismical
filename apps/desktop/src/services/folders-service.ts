import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as folderDb from "../db/folders";
import { db as defaultDb } from "../db";
import type { Folder } from "../db/schema";

const MAX_NAME_LEN = 64;

export interface CreateFolderInput {
  name: string;
  parentId?: number | null;
}
export interface UpdateFolderInput {
  name?: string;
  isFavorite?: boolean;
}

type DB = LibSQLDatabase<Record<string, unknown>>;

export class FoldersService {
  private static singleton: FoldersService | null = null;
  private db: DB;

  constructor(db: DB = defaultDb as unknown as DB) {
    this.db = db;
  }

  static getInstance(): FoldersService {
    if (!FoldersService.singleton) FoldersService.singleton = new FoldersService();
    return FoldersService.singleton;
  }

  private validateName(raw: string): string {
    const name = raw.trim();
    if (name.length === 0) throw new Error("Folder name is required");
    if (name.length > MAX_NAME_LEN)
      throw new Error(`Folder name must be ${MAX_NAME_LEN} characters or fewer`);
    return name;
  }

  async createFolder(input: CreateFolderInput): Promise<Folder> {
    const name = this.validateName(input.name);
    const parentId = input.parentId ?? null;
    const existing = await folderDb.getFolderByNameAndParent(this.db, name, parentId);
    if (existing) return existing;
    return await folderDb.createFolder(this.db, { name, parentId });
  }

  async updateFolder(id: number, patch: UpdateFolderInput): Promise<Folder> {
    const dbPatch: { name?: string; isFavorite?: boolean } = {};
    if (patch.name !== undefined) {
      const name = this.validateName(patch.name);
      // Look up the current parent so the collision check is sibling-scoped.
      const current = await folderDb.getFolderById(this.db, id);
      const parentId = current?.parentId ?? null;
      const collision = await folderDb.getFolderByNameAndParent(this.db, name, parentId);
      if (collision && collision.id !== id) {
        throw new Error(`A folder named "${collision.name}" already exists`);
      }
      dbPatch.name = name;
    }
    if (patch.isFavorite !== undefined) dbPatch.isFavorite = patch.isFavorite;
    return await folderDb.updateFolder(this.db, id, dbPatch);
  }

  async deleteFolder(id: number): Promise<folderDb.FolderDeleteResult> {
    return await folderDb.deleteFolder(this.db, id);
  }

  getDeletePreview(id: number): Promise<folderDb.FolderDeletePreview> {
    return folderDb.getFolderDeletePreview(this.db, id);
  }

  list(opts: folderDb.ListFoldersOptions = {}) {
    return folderDb.listFolders(this.db, opts);
  }
  listFavorites() {
    return folderDb.listFavoriteFolders(this.db);
  }
  listWithCounts(opts: folderDb.ListFoldersOptions = {}) {
    return folderDb.listAllFoldersWithCounts(this.db, opts);
  }
  async getTreeWithCounts() {
    const [folderRows, unfiledCount] = await Promise.all([
      folderDb.listWithRecursiveCounts(this.db),
      folderDb.countUnfiled(this.db),
    ]);
    return { folders: folderRows, unfiledCount };
  }
  getById(id: number) {
    return folderDb.getFolderById(this.db, id);
  }
}

export default FoldersService;
