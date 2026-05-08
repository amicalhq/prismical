import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  deleteTestDatabase,
  type TestDatabase,
} from "../helpers/test-db";
import { TagsService } from "@/services/tags-service";

let testDb: TestDatabase;
let svc: TagsService;

beforeEach(async () => {
  testDb = await createTestDatabase({ name: `tags-svc-${Date.now()}.db` });
  svc = new TagsService(testDb.db); // test-only constructor accepting db
});
afterEach(async () => {
  await testDb.close();
  await deleteTestDatabase(testDb.dbPath);
});

describe("TagsService", () => {
  describe("createTag", () => {
    it("lowercases name and assigns auto-color from preset rotation", async () => {
      const t = await svc.createTag({ name: "Work" });
      expect(t.name).toBe("work");
      expect(t.color).toMatch(/^#[0-9a-f]{6}$/);
    });

    it("rotates through 7 presets", async () => {
      const colors: string[] = [];
      for (let i = 0; i < 7; i++) {
        const t = await svc.createTag({ name: `t${i}` });
        colors.push(t.color);
      }
      expect(new Set(colors).size).toBe(7);
    });

    it("returns existing row when name collides (case-insensitive)", async () => {
      const a = await svc.createTag({ name: "Work" });
      const b = await svc.createTag({ name: "WORK" });
      expect(b.id).toBe(a.id);
    });

    it("rejects names with disallowed chars", async () => {
      await expect(svc.createTag({ name: "has spaces" })).rejects.toThrow();
      await expect(svc.createTag({ name: "has!punct" })).rejects.toThrow();
    });

    it("rejects names longer than 32 chars", async () => {
      await expect(svc.createTag({ name: "a".repeat(33) })).rejects.toThrow();
    });

    it("rejects empty names", async () => {
      await expect(svc.createTag({ name: "" })).rejects.toThrow();
    });

    it("preserves explicit color", async () => {
      const t = await svc.createTag({ name: "x", color: "#abcdef" });
      expect(t.color).toBe("#abcdef");
    });

    it("rejects invalid hex on create", async () => {
      await expect(svc.createTag({ name: "x", color: "red" })).rejects.toThrow();
    });
  });

  describe("updateTag", () => {
    it("normalizes name on rename", async () => {
      const t = await svc.createTag({ name: "x" });
      const u = await svc.updateTag(t.id, { name: "Renamed" });
      expect(u.name).toBe("renamed");
    });

    it("rejects invalid hex on color update", async () => {
      const t = await svc.createTag({ name: "x" });
      await expect(svc.updateTag(t.id, { color: "purple" })).rejects.toThrow();
    });

    it("toggles isFavorite", async () => {
      const t = await svc.createTag({ name: "x" });
      const u = await svc.updateTag(t.id, { isFavorite: true });
      expect(u.isFavorite).toBe(true);
    });
  });

  describe("deleteTag", () => {
    it("returns count of detached note_tags", async () => {
      const { notes } = await import("@db/schema");
      const [n] = await testDb.db.insert(notes).values({ title: "n" }).returning();
      const t = await svc.createTag({ name: "x" });
      await svc.attachTag(n.id, t.id);
      const result = await svc.deleteTag(t.id);
      expect(result.detachedNoteCount).toBe(1);
    });
  });
});
