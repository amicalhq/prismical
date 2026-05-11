import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { notes } from "@db/schema";
import {
  createTestDatabase,
  deleteTestDatabase,
  type TestDatabase,
} from "../helpers/test-db";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = await createTestDatabase({ name: `artifacts-db-${Date.now()}.db` });
});
afterEach(async () => {
  await testDb.close();
  await deleteTestDatabase(testDb.dbPath);
});

async function insertNote(): Promise<number> {
  const [row] = await testDb.db
    .insert(notes)
    .values({ title: "n" })
    .returning();
  return row.id;
}

describe("db/artifacts (append-only audit log)", () => {
  it("appendArtifact inserts a row with the provided fields", async () => {
    const { appendArtifact } = await import("@db/artifacts");
    const noteId = await insertNote();
    const row = await appendArtifact(testDb.db, {
      noteId,
      skillId: "enhance",
      mode: "append-section",
      content: '{"lexical":"state"}',
      generator: "ai",
      modelId: "claude-opus-4-7",
      meta: { foo: "bar" },
    });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.skillId).toBe("enhance");
    expect(row.mode).toBe("append-section");
    expect(row.version).toBe(1);
    expect(row.modelId).toBe("claude-opus-4-7");
    expect(row.meta).toEqual({ foo: "bar" });
  });

  it("appendArtifact monotonically increments version within (noteId, skillId) for append-section", async () => {
    const { appendArtifact } = await import("@db/artifacts");
    const noteId = await insertNote();
    const a = await appendArtifact(testDb.db, {
      noteId,
      skillId: "enhance",
      mode: "append-section",
      content: "v1",
      generator: "ai",
    });
    const b = await appendArtifact(testDb.db, {
      noteId,
      skillId: "enhance",
      mode: "append-section",
      content: "v2",
      generator: "ai",
    });
    const c = await appendArtifact(testDb.db, {
      noteId,
      skillId: "enhance",
      mode: "append-section",
      content: "v3",
      generator: "ai",
    });
    expect([a.version, b.version, c.version]).toEqual([1, 2, 3]);
  });

  it("version stays at 1 for replace-doc and inline-rewrite (each row is independent)", async () => {
    const { appendArtifact } = await import("@db/artifacts");
    const noteId = await insertNote();
    const replace1 = await appendArtifact(testDb.db, {
      noteId,
      skillId: "cleanup",
      mode: "replace-doc",
      content: "x",
      generator: "ai",
    });
    const replace2 = await appendArtifact(testDb.db, {
      noteId,
      skillId: "cleanup",
      mode: "replace-doc",
      content: "y",
      generator: "ai",
    });
    const inline1 = await appendArtifact(testDb.db, {
      noteId,
      skillId: "fix-grammar",
      mode: "inline-rewrite",
      content: "z",
      generator: "ai",
    });
    expect(replace1.version).toBe(1);
    expect(replace2.version).toBe(1);
    expect(inline1.version).toBe(1);
  });

  it("replace-doc rows for the same skillId do not inflate the append-section counter", async () => {
    const { appendArtifact } = await import("@db/artifacts");
    const noteId = await insertNote();
    await appendArtifact(testDb.db, {
      noteId,
      skillId: "enhance",
      mode: "replace-doc",
      content: "r1",
      generator: "ai",
    });
    await appendArtifact(testDb.db, {
      noteId,
      skillId: "enhance",
      mode: "replace-doc",
      content: "r2",
      generator: "ai",
    });
    const first = await appendArtifact(testDb.db, {
      noteId,
      skillId: "enhance",
      mode: "append-section",
      content: "a1",
      generator: "ai",
    });
    expect(first.version).toBe(1);
  });

  it("version sequence is per (noteId, skillId) — different skills do not share counters", async () => {
    const { appendArtifact } = await import("@db/artifacts");
    const noteId = await insertNote();
    const enhanceA = await appendArtifact(testDb.db, {
      noteId,
      skillId: "enhance",
      mode: "append-section",
      content: "a",
      generator: "ai",
    });
    const actionA = await appendArtifact(testDb.db, {
      noteId,
      skillId: "action-items",
      mode: "append-section",
      content: "b",
      generator: "ai",
    });
    const enhanceB = await appendArtifact(testDb.db, {
      noteId,
      skillId: "enhance",
      mode: "append-section",
      content: "c",
      generator: "ai",
    });
    expect(enhanceA.version).toBe(1);
    expect(actionA.version).toBe(1);
    expect(enhanceB.version).toBe(2);
  });

  it("listArtifactsByNote returns all rows for the note, newest first", async () => {
    const { appendArtifact, listArtifactsByNote } = await import(
      "@db/artifacts"
    );
    const noteId = await insertNote();
    await appendArtifact(testDb.db, {
      noteId,
      skillId: "enhance",
      mode: "append-section",
      content: "a",
      generator: "ai",
      generatedAt: new Date(2026, 0, 1),
    });
    await appendArtifact(testDb.db, {
      noteId,
      skillId: "cleanup",
      mode: "replace-doc",
      content: "b",
      generator: "ai",
      generatedAt: new Date(2026, 0, 2),
    });
    const rows = await listArtifactsByNote(testDb.db, noteId);
    expect(rows.map((r) => r.skillId)).toEqual(["cleanup", "enhance"]);
  });

  it("listArtifactsByNoteAndSkill returns rows ordered by version desc", async () => {
    const { appendArtifact, listArtifactsByNoteAndSkill } = await import(
      "@db/artifacts"
    );
    const noteId = await insertNote();
    for (let i = 0; i < 3; i++) {
      await appendArtifact(testDb.db, {
        noteId,
        skillId: "enhance",
        mode: "append-section",
        content: `v${i + 1}`,
        generator: "ai",
      });
    }
    const rows = await listArtifactsByNoteAndSkill(
      testDb.db,
      noteId,
      "enhance",
    );
    expect(rows.map((r) => r.version)).toEqual([3, 2, 1]);
  });
});
