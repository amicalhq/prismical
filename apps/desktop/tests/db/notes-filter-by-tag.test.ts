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
    void n2;
  });

  it("returns empty when tag has no notes", async () => {
    const { createTag } = await import("@db/tags");
    const { getNotes } = await import("@db/notes");
    const t = await createTag(testDb.db, { name: "y", color: "#10b981" });
    const got = await getNotes({ tagId: t.id });
    expect(got).toEqual([]);
  });
});

describe("getNotes(tagIds AND, folderIds IN)", () => {
  it("returns notes that have ALL of the given tagIds", async () => {
    const { createTag, attachTag } = await import("@db/tags");
    const { getNotes } = await import("@db/notes");
    const [n1] = await testDb.db.insert(notes).values({ title: "both" }).returning();
    const [n2] = await testDb.db.insert(notes).values({ title: "one" }).returning();
    const a = await createTag(testDb.db, { name: "a", color: "#10b981" });
    const b = await createTag(testDb.db, { name: "b", color: "#60a5fa" });
    await attachTag(testDb.db, n1.id, a.id);
    await attachTag(testDb.db, n1.id, b.id);
    await attachTag(testDb.db, n2.id, a.id);

    const got = await getNotes({ tagIds: [a.id, b.id] });
    expect(got.map((n) => n.id)).toEqual([n1.id]);
    void n2;
  });

  it("returns notes whose folderId is in folderIds", async () => {
    const { createFolder } = await import("@db/folders");
    const { getNotes } = await import("@db/notes");
    const f1 = await createFolder(testDb.db, { name: "F1" });
    const f2 = await createFolder(testDb.db, { name: "F2" });
    const f3 = await createFolder(testDb.db, { name: "F3" });
    const [n1] = await testDb.db.insert(notes).values({ title: "in1", folderId: f1.id }).returning();
    const [n2] = await testDb.db.insert(notes).values({ title: "in2", folderId: f2.id }).returning();
    await testDb.db.insert(notes).values({ title: "in3", folderId: f3.id });

    const got = await getNotes({ folderIds: [f1.id, f2.id] });
    expect(new Set(got.map((n) => n.id))).toEqual(new Set([n1.id, n2.id]));
  });

  it("AND-combines tagIds with folderIds", async () => {
    const { createFolder } = await import("@db/folders");
    const { createTag, attachTag } = await import("@db/tags");
    const { getNotes } = await import("@db/notes");
    const f = await createFolder(testDb.db, { name: "F" });
    const t = await createTag(testDb.db, { name: "t", color: "#10b981" });
    const [n1] = await testDb.db.insert(notes).values({ title: "match", folderId: f.id }).returning();
    const [n2] = await testDb.db.insert(notes).values({ title: "in folder, no tag", folderId: f.id }).returning();
    const [n3] = await testDb.db.insert(notes).values({ title: "tag, no folder" }).returning();
    await attachTag(testDb.db, n1.id, t.id);
    await attachTag(testDb.db, n3.id, t.id);

    const got = await getNotes({ folderIds: [f.id], tagIds: [t.id] });
    expect(got.map((n) => n.id)).toEqual([n1.id]);
    void n2;
    void n3;
  });

  it("empty tagIds array does not filter", async () => {
    const { getNotes } = await import("@db/notes");
    await testDb.db.insert(notes).values({ title: "anyone" });
    const got = await getNotes({ tagIds: [] });
    expect(got).toHaveLength(1);
  });

  it("empty folderIds array does not filter", async () => {
    const { getNotes } = await import("@db/notes");
    await testDb.db.insert(notes).values({ title: "anyone" });
    const got = await getNotes({ folderIds: [] });
    expect(got).toHaveLength(1);
  });
});
