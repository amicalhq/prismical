import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { notes } from "@db/schema";
import {
  createTestDatabase,
  deleteTestDatabase,
  type TestDatabase,
} from "../helpers/test-db";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = await createTestDatabase({ name: `folders-db-${Date.now()}.db` });
});
afterEach(async () => {
  await testDb.close();
  await deleteTestDatabase(testDb.dbPath);
});

describe("db/folders", () => {
  it("createFolder persists row with isFavorite default false", async () => {
    const { createFolder } = await import("@db/folders");
    const row = await createFolder(testDb.db, { name: "Work Projects" });
    expect(row.id).toBeGreaterThan(0);
    expect(row.name).toBe("Work Projects");
    expect(row.isFavorite).toBe(false);
  });

  it("getFolderByLowerName matches case-insensitively", async () => {
    const { createFolder, getFolderByLowerName } = await import("@db/folders");
    await createFolder(testDb.db, { name: "Work" });
    const got = await getFolderByLowerName(testDb.db, "WORK");
    expect(got?.name).toBe("Work");
    expect(await getFolderByLowerName(testDb.db, "absent")).toBeNull();
  });

  it("listFolders sorts by createdAt desc by default", async () => {
    const { createFolder, listFolders } = await import("@db/folders");
    const a = await createFolder(testDb.db, { name: "A" });
    await new Promise((r) => setTimeout(r, 10));
    const b = await createFolder(testDb.db, { name: "B" });
    const got = await listFolders(testDb.db);
    expect(got.map((f) => f.id)).toEqual([b.id, a.id]);
  });

  it("listFavoriteFolders filters by isFavorite", async () => {
    const { createFolder, updateFolder, listFavoriteFolders } = await import(
      "@db/folders"
    );
    const a = await createFolder(testDb.db, { name: "A" });
    await createFolder(testDb.db, { name: "B" });
    await updateFolder(testDb.db, a.id, { isFavorite: true });
    const got = await listFavoriteFolders(testDb.db);
    expect(got.map((f) => f.name)).toEqual(["A"]);
  });

  it("listAllFoldersWithCounts returns note counts per folder", async () => {
    const { createFolder, listAllFoldersWithCounts } = await import(
      "@db/folders"
    );
    const f = await createFolder(testDb.db, { name: "Work" });
    await testDb.db.insert(notes).values({ title: "n1", folderId: f.id });
    await testDb.db.insert(notes).values({ title: "n2", folderId: f.id });
    await testDb.db.insert(notes).values({ title: "orphan" });
    const got = await listAllFoldersWithCounts(testDb.db);
    expect(got).toHaveLength(1);
    expect(got[0].noteCount).toBe(2);
  });

  it("deleteFolder cascade-deletes contained notes", async () => {
    const { createFolder, deleteFolder } = await import("@db/folders");
    const f = await createFolder(testDb.db, { name: "Work" });
    const [n] = await testDb.db
      .insert(notes)
      .values({ title: "n", folderId: f.id })
      .returning();
    const result = await deleteFolder(testDb.db, f.id);
    expect(result.deletedNoteCount).toBe(1);
    const [after] = await testDb.db
      .select()
      .from(notes)
      .where(eq(notes.id, n.id));
    expect(after).toBeUndefined();
  });

  it("allows same folder name under different parents", async () => {
    const { createFolder } = await import("@db/folders");
    const a = await createFolder(testDb.db, { name: "Work" });
    const b = await createFolder(testDb.db, { name: "Personal" });

    const childA = await createFolder(testDb.db, {
      name: "Notes",
      parentId: a.id,
    });
    const childB = await createFolder(testDb.db, {
      name: "Notes",
      parentId: b.id,
    });

    expect(childA.parentId).toBe(a.id);
    expect(childB.parentId).toBe(b.id);
  });

  it("rejects duplicate folder name under the same parent", async () => {
    const { createFolder } = await import("@db/folders");
    const root = await createFolder(testDb.db, { name: "Work" });
    await createFolder(testDb.db, { name: "Notes", parentId: root.id });

    await expect(
      createFolder(testDb.db, { name: "notes", parentId: root.id }),
    ).rejects.toThrow();
  });

  it("rejects duplicate top-level folder names", async () => {
    const { createFolder } = await import("@db/folders");
    await createFolder(testDb.db, { name: "Work" });
    await expect(createFolder(testDb.db, { name: "WORK" })).rejects.toThrow();
  });

  it("listAllForTree returns every folder ordered by parent then name", async () => {
    const { createFolder, listAllForTree } = await import("@db/folders");
    const work = await createFolder(testDb.db, { name: "Work" });
    const personal = await createFolder(testDb.db, { name: "Personal" });
    await createFolder(testDb.db, { name: "Hiring", parentId: work.id });
    await createFolder(testDb.db, { name: "Q4", parentId: work.id });

    const got = await listAllForTree(testDb.db);
    const names = got.map((f) => f.name);
    expect(names).toContain("Work");
    expect(names).toContain("Personal");
    expect(names).toContain("Hiring");
    expect(names).toContain("Q4");
    // Top-level rows precede their children
    const workIdx = names.indexOf("Work");
    const hiringIdx = names.indexOf("Hiring");
    expect(workIdx).toBeLessThan(hiringIdx);
    void personal;
  });

  it("subtreeIds returns root + descendants", async () => {
    const { createFolder, subtreeIds } = await import("@db/folders");
    const root = await createFolder(testDb.db, { name: "Root" });
    const child = await createFolder(testDb.db, { name: "C", parentId: root.id });
    const grand = await createFolder(testDb.db, { name: "G", parentId: child.id });
    const sibling = await createFolder(testDb.db, { name: "S" });

    const ids = await subtreeIds(testDb.db, root.id);
    expect(new Set(ids)).toEqual(new Set([root.id, child.id, grand.id]));
    expect(ids).not.toContain(sibling.id);
  });
});
