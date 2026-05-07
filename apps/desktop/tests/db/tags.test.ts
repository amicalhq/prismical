import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tags, noteTags, notes } from "@db/schema";
import {
  createTestDatabase,
  deleteTestDatabase,
  type TestDatabase,
} from "../helpers/test-db";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = await createTestDatabase({ name: `tags-db-${Date.now()}.db` });
});
afterEach(async () => {
  await testDb.close();
  await deleteTestDatabase(testDb.dbPath);
});

describe("db/tags", () => {
  it("persists and returns the row", async () => {
    const { createTag } = await import("@db/tags");
    const row = await createTag(testDb.db, { name: "meeting", color: "#f59e0b" });
    expect(row.id).toBeGreaterThan(0);
    expect(row.name).toBe("meeting");
    expect(row.color).toBe("#f59e0b");
    expect(row.isFavorite).toBe(false);
  });

  it("getTagByName returns null when missing, row when present", async () => {
    const { createTag, getTagByName } = await import("@db/tags");
    expect(await getTagByName(testDb.db, "absent")).toBeNull();
    await createTag(testDb.db, { name: "work", color: "#10b981" });
    const got = await getTagByName(testDb.db, "work");
    expect(got?.color).toBe("#10b981");
  });

  it("listTagsByNoteId joins through note_tags", async () => {
    const { createTag, attachTag, listTagsByNoteId } = await import("@db/tags");
    const [note] = await testDb.db.insert(notes).values({ title: "n" }).returning();
    const a = await createTag(testDb.db, { name: "a", color: "#f59e0b" });
    const b = await createTag(testDb.db, { name: "b", color: "#10b981" });
    await attachTag(testDb.db, note.id, a.id);
    await attachTag(testDb.db, note.id, b.id);
    const got = await listTagsByNoteId(testDb.db, note.id);
    expect(got.map((t) => t.name).sort()).toEqual(["a", "b"]);
  });

  it("attachTag is idempotent (INSERT OR IGNORE)", async () => {
    const { createTag, attachTag } = await import("@db/tags");
    const [note] = await testDb.db.insert(notes).values({ title: "n" }).returning();
    const t = await createTag(testDb.db, { name: "x", color: "#f59e0b" });
    await attachTag(testDb.db, note.id, t.id);
    await attachTag(testDb.db, note.id, t.id); // must not throw on PK collision
    const rows = await testDb.db.select().from(noteTags);
    expect(rows).toHaveLength(1);
  });

  it("deleteTag cascades note_tags rows", async () => {
    const { createTag, attachTag, deleteTag } = await import("@db/tags");
    const [note] = await testDb.db.insert(notes).values({ title: "n" }).returning();
    const t = await createTag(testDb.db, { name: "x", color: "#f59e0b" });
    await attachTag(testDb.db, note.id, t.id);
    await deleteTag(testDb.db, t.id);
    const rows = await testDb.db.select().from(noteTags);
    expect(rows).toHaveLength(0);
  });

  it("listAllTagsWithCounts returns counts via group-by", async () => {
    const { createTag, attachTag, listAllTagsWithCounts } = await import("@db/tags");
    const [n1] = await testDb.db.insert(notes).values({ title: "n1" }).returning();
    const [n2] = await testDb.db.insert(notes).values({ title: "n2" }).returning();
    const t = await createTag(testDb.db, { name: "x", color: "#f59e0b" });
    await attachTag(testDb.db, n1.id, t.id);
    await attachTag(testDb.db, n2.id, t.id);
    const got = await listAllTagsWithCounts(testDb.db, { sortBy: "createdAt" });
    expect(got).toHaveLength(1);
    expect(got[0].noteCount).toBe(2);
  });
});
