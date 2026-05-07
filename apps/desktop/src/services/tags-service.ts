import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as tagDb from "../db/tags";
import { db as defaultDb } from "../db";
import { tags as tagsTable } from "../db/schema";
import { sql } from "drizzle-orm";
import { normalizeHex, nextAutoColor } from "../renderer/main/lib/tag-colors";
import type { Tag } from "../db/schema";

const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const MAX_NAME_LEN = 32;

export interface CreateTagInput {
  name: string;
  color?: string;
}
export interface UpdateTagInput {
  name?: string;
  color?: string;
  isFavorite?: boolean;
}

type DB = LibSQLDatabase<Record<string, unknown>>;

export class TagsService {
  private static singleton: TagsService | null = null;
  private db: DB;

  // Production code uses TagsService.getInstance(); tests pass a db explicitly.
  constructor(db: DB = defaultDb as unknown as DB) {
    this.db = db;
  }

  static getInstance(): TagsService {
    if (!TagsService.singleton) TagsService.singleton = new TagsService();
    return TagsService.singleton;
  }

  private validateName(raw: string): string {
    const name = raw.trim().toLowerCase();
    if (name.length === 0) throw new Error("Tag name is required");
    if (name.length > MAX_NAME_LEN)
      throw new Error(`Tag name must be ${MAX_NAME_LEN} characters or fewer`);
    if (!NAME_RE.test(name))
      throw new Error(
        "Tag name can only contain lowercase letters, digits, '-' and '_'",
      );
    return name;
  }

  private validateColor(hex: string): string {
    const normalized = normalizeHex(hex);
    if (!normalized) throw new Error(`Invalid color: ${hex}`);
    return normalized;
  }

  private async pickAutoColor(): Promise<string> {
    const [{ count }] = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(tagsTable);
    return nextAutoColor(Number(count));
  }

  async createTag(input: CreateTagInput): Promise<Tag> {
    const name = this.validateName(input.name);

    // Return existing if name collides
    const existing = await tagDb.getTagByName(this.db, name);
    if (existing) return existing;

    const color = input.color
      ? this.validateColor(input.color)
      : await this.pickAutoColor();
    return await tagDb.insertTag(this.db, { name, color });
  }

  async updateTag(id: number, patch: UpdateTagInput): Promise<Tag> {
    const dbPatch: { name?: string; color?: string; isFavorite?: boolean } = {};
    if (patch.name !== undefined) dbPatch.name = this.validateName(patch.name);
    if (patch.color !== undefined) dbPatch.color = this.validateColor(patch.color);
    if (patch.isFavorite !== undefined) dbPatch.isFavorite = patch.isFavorite;
    return await tagDb.updateTag(this.db, id, dbPatch);
  }

  async deleteTag(id: number): Promise<{ ok: true; detachedNoteCount: number }> {
    const { detachedNoteCount } = await tagDb.deleteTag(this.db, id);
    return { ok: true, detachedNoteCount };
  }

  async attachTag(noteId: number, tagId: number): Promise<{ ok: true }> {
    await tagDb.attachTag(this.db, noteId, tagId);
    return { ok: true };
  }

  async detachTag(noteId: number, tagId: number): Promise<{ ok: true }> {
    await tagDb.detachTag(this.db, noteId, tagId);
    return { ok: true };
  }

  list(opts: tagDb.ListTagsOptions = {}) {
    return tagDb.listTags(this.db, opts);
  }
  listRecent(limit: number) {
    return tagDb.listRecentTags(this.db, limit);
  }
  listFavorites() {
    return tagDb.listFavoriteTags(this.db);
  }
  listWithCounts(opts: tagDb.ListTagsOptions = {}) {
    return tagDb.listAllTagsWithCounts(this.db, opts);
  }
  getForNote(noteId: number) {
    return tagDb.listTagsByNoteId(this.db, noteId);
  }
  getById(id: number) {
    return tagDb.getTagById(this.db, id);
  }
}

export default TagsService;
