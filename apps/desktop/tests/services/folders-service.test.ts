import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import {
  createTestDatabase,
  deleteTestDatabase,
  type TestDatabase,
} from "../helpers/test-db";
import { FoldersService } from "@/services/folders-service";
import {
  folders,
  noteArtifacts,
  notes,
  noteTags,
  tags,
  yjsUpdates,
} from "@db/schema";

let testDb: TestDatabase;
let service: FoldersService;

beforeEach(async () => {
  testDb = await createTestDatabase({ name: `folders-svc-${Date.now()}.db` });
  service = new FoldersService(testDb.db);
});
afterEach(async () => {
  await testDb.close();
  await deleteTestDatabase(testDb.dbPath);
});

describe("FoldersService", () => {
  it("createFolder trims whitespace and stores user casing", async () => {
    const f = await service.createFolder({ name: "  Work Projects  " });
    expect(f.name).toBe("Work Projects");
  });

  it("createFolder rejects empty/oversized names", async () => {
    await expect(service.createFolder({ name: "" })).rejects.toThrow(
      /required/i,
    );
    await expect(service.createFolder({ name: "   " })).rejects.toThrow(
      /required/i,
    );
    await expect(service.createFolder({ name: "x".repeat(65) })).rejects.toThrow(
      /64/,
    );
  });

  it("createFolder returns existing folder on case-insensitive name collision", async () => {
    const a = await service.createFolder({ name: "Work" });
    const b = await service.createFolder({ name: "WORK" });
    expect(b.id).toBe(a.id);
    expect(b.name).toBe("Work"); // existing display name preserved
  });

  it("updateFolder validates name and stores trimmed value", async () => {
    const a = await service.createFolder({ name: "A" });
    const updated = await service.updateFolder(a.id, { name: "  Renamed  " });
    expect(updated.name).toBe("Renamed");
    await expect(
      service.updateFolder(a.id, { name: "" }),
    ).rejects.toThrow(/required/i);
  });

  it("updateFolder rejects rename that collides with another folder (case-insensitive)", async () => {
    await service.createFolder({ name: "Work" });
    const b = await service.createFolder({ name: "Personal" });
    await expect(
      service.updateFolder(b.id, { name: "WORK" }),
    ).rejects.toThrow(/already exists/i);
  });

  it("toggleFavorite flips isFavorite", async () => {
    const a = await service.createFolder({ name: "A" });
    const f1 = await service.updateFolder(a.id, { isFavorite: true });
    expect(f1.isFavorite).toBe(true);
    const f2 = await service.updateFolder(a.id, { isFavorite: false });
    expect(f2.isFavorite).toBe(false);
  });

  describe("deleteFolder cascades through subfolders and notes", () => {
    async function seedTree() {
      const root = await service.createFolder({ name: "root" });
      const child = await service.createFolder({ name: "child" });
      const grand = await service.createFolder({ name: "grand" });
      const sibling = await service.createFolder({ name: "sibling" });
      // Reparent child → root, grand → child via direct DB write since
      // service.create doesn't expose parentId yet.
      await testDb.db
        .update(folders)
        .set({ parentId: root.id })
        .where(eq(folders.id, child.id));
      await testDb.db
        .update(folders)
        .set({ parentId: child.id })
        .where(eq(folders.id, grand.id));

      // Two notes in root, one in grand, one in sibling (untouched), one
      // unfiled (untouched).
      await testDb.db.insert(notes).values([
        { title: "n1", folderId: root.id },
        { title: "n2", folderId: root.id },
        { title: "n3", folderId: grand.id },
        { title: "n4", folderId: sibling.id },
        { title: "n5", folderId: null },
      ]);

      return { root, child, grand, sibling };
    }

    it("getDeletePreview returns transitive subfolder + note counts", async () => {
      const { root } = await seedTree();
      const preview = await service.getDeletePreview(root.id);
      // Subfolders: child + grand. Notes: n1, n2 (root) + n3 (grand) = 3.
      expect(preview).toEqual({ subfolderCount: 2, noteCount: 3 });
    });

    it("deleteFolder removes the subtree and reports counts", async () => {
      const { root, sibling } = await seedTree();
      const result = await service.deleteFolder(root.id);
      expect(result).toEqual({
        deletedSubfolderCount: 2, // child + grand (excludes root)
        deletedNoteCount: 3,
      });

      const remainingFolders = await testDb.db.select().from(folders);
      expect(remainingFolders.map((f) => f.id)).toEqual([sibling.id]);

      const remainingNotes = await testDb.db.select().from(notes);
      // n4 (in sibling) and n5 (unfiled) survive.
      expect(remainingNotes.map((n) => n.title).sort()).toEqual(["n4", "n5"]);
    });

    it("deleteFolder on a leaf folder only deletes its own notes", async () => {
      const { sibling } = await seedTree();
      const result = await service.deleteFolder(sibling.id);
      expect(result).toEqual({
        deletedSubfolderCount: 0,
        deletedNoteCount: 1,
      });

      const [{ c }] = await testDb.db
        .select({ c: sql<number>`COUNT(*)` })
        .from(folders)
        .where(inArray(folders.name, ["sibling"]));
      expect(Number(c)).toBe(0);
    });

    it("deleteFolder on a missing id is a no-op", async () => {
      const result = await service.deleteFolder(99999);
      expect(result).toEqual({
        deletedSubfolderCount: 0,
        deletedNoteCount: 0,
      });
    });

    it("a second deleteFolder on the same id is a no-op", async () => {
      const { root } = await seedTree();
      await service.deleteFolder(root.id);
      const second = await service.deleteFolder(root.id);
      expect(second).toEqual({
        deletedSubfolderCount: 0,
        deletedNoteCount: 0,
      });
    });

    it("preview reports zero notes for a folder whose contents are only subfolders", async () => {
      const root = await service.createFolder({ name: "shell" });
      const child = await service.createFolder({ name: "shell-child" });
      await testDb.db
        .update(folders)
        .set({ parentId: root.id })
        .where(eq(folders.id, child.id));

      const preview = await service.getDeletePreview(root.id);
      expect(preview).toEqual({ subfolderCount: 1, noteCount: 0 });

      const result = await service.deleteFolder(root.id);
      expect(result).toEqual({
        deletedSubfolderCount: 1,
        deletedNoteCount: 0,
      });
    });

    it("a sibling subtree is fully untouched when the other root is deleted", async () => {
      // Two independent trees: A → A1 (with note nA1), B → B1 (with note nB1).
      const a = await service.createFolder({ name: "A" });
      const a1 = await service.createFolder({ name: "A1" });
      const b = await service.createFolder({ name: "B" });
      const b1 = await service.createFolder({ name: "B1" });
      await testDb.db
        .update(folders)
        .set({ parentId: a.id })
        .where(eq(folders.id, a1.id));
      await testDb.db
        .update(folders)
        .set({ parentId: b.id })
        .where(eq(folders.id, b1.id));
      await testDb.db.insert(notes).values([
        { title: "nA1", folderId: a1.id },
        { title: "nB1", folderId: b1.id },
      ]);

      await service.deleteFolder(a.id);

      const remainingFolders = await testDb.db
        .select({ id: folders.id, name: folders.name })
        .from(folders);
      expect(remainingFolders.map((f) => f.name).sort()).toEqual(["B", "B1"]);

      const remainingNotes = await testDb.db
        .select({ title: notes.title, folderId: notes.folderId })
        .from(notes);
      expect(remainingNotes).toEqual([{ title: "nB1", folderId: b1.id }]);
    });

    it("deleteFolder is bounded even if parent_id forms a cycle", async () => {
      const a = await service.createFolder({ name: "cyc-A" });
      const b = await service.createFolder({ name: "cyc-B" });
      // A → B and B → A; classic cycle.
      await testDb.db
        .update(folders)
        .set({ parentId: b.id })
        .where(eq(folders.id, a.id));
      await testDb.db
        .update(folders)
        .set({ parentId: a.id })
        .where(eq(folders.id, b.id));

      const result = await service.deleteFolder(a.id);
      expect(result.deletedSubfolderCount).toBe(1); // B is the only descendant
      expect(result.deletedNoteCount).toBe(0);

      const remainingFolders = await testDb.db.select().from(folders);
      expect(remainingFolders).toEqual([]);
    });

    it("cascading delete drops note tags, artifacts, and yjs updates", async () => {
      const root = await service.createFolder({ name: "doomed" });

      const [note] = await testDb.db
        .insert(notes)
        .values({ title: "doomed-note", folderId: root.id })
        .returning();
      const [tag] = await testDb.db
        .insert(tags)
        .values({ name: "doomed-tag", color: "#000000" })
        .returning();
      await testDb.db
        .insert(noteTags)
        .values({ noteId: note.id, tagId: tag.id });
      await testDb.db.insert(noteArtifacts).values({
        id: "doomed-artifact",
        noteId: note.id,
        kind: "summary",
        content: "{}",
        generator: "user",
      });
      await testDb.db.insert(yjsUpdates).values({
        noteId: note.id,
        updateData: Buffer.from([1, 2, 3]),
      });

      await service.deleteFolder(root.id);

      const tagJoinCount = (
        await testDb.db.select({ id: noteTags.noteId }).from(noteTags)
      ).length;
      const artifactCount = (
        await testDb.db.select({ id: noteArtifacts.id }).from(noteArtifacts)
      ).length;
      const yjsCount = (
        await testDb.db.select({ id: yjsUpdates.noteId }).from(yjsUpdates)
      ).length;

      expect(tagJoinCount).toBe(0);
      expect(artifactCount).toBe(0);
      expect(yjsCount).toBe(0);
      // The tag itself should still exist (only the join was cascaded).
      const [tagAfter] = await testDb.db
        .select()
        .from(tags)
        .where(eq(tags.id, tag.id));
      expect(tagAfter?.id).toBe(tag.id);
    });
  });
});
