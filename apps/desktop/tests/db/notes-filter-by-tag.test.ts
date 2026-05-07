import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  deleteTestDatabase,
  type TestDatabase,
} from "../helpers/test-db";
import { setTestDatabase } from "../setup";
import { notes } from "@db/schema";

let testDb: TestDatabase;
beforeEach(async () => {
  testDb = await createTestDatabase({ name: `notes-tag-${Date.now()}.db` });
  setTestDatabase(testDb.db);
});
afterEach(async () => {
  await testDb.close();
  await deleteTestDatabase(testDb.dbPath);
});

describe("getNotes(tagId)", () => {
  it("filters notes to those attached to the tag", async () => {
    const { createTag, attachTag } = await import("@db/tags");
    const { getNotes } = await import("@db/notes");
    const [n1] = await testDb.db.insert(notes).values({ title: "with" }).returning();
    const [n2] = await testDb.db.insert(notes).values({ title: "without" }).returning();
    const t = await createTag(testDb.db, { name: "x", color: "#f59e0b" });
    await attachTag(testDb.db, n1.id, t.id);

    const got = await getNotes({ tagId: t.id });
    expect(got.map((n) => n.id)).toEqual([n1.id]);
  });

  it("returns empty when tag has no notes", async () => {
    const { createTag } = await import("@db/tags");
    const { getNotes } = await import("@db/notes");
    const t = await createTag(testDb.db, { name: "y", color: "#10b981" });
    const got = await getNotes({ tagId: t.id });
    expect(got).toEqual([]);
  });
});
