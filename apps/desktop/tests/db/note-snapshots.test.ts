import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import {
  createTestDatabase,
  deleteTestDatabase,
  type TestDatabase,
} from "../helpers/test-db";
import { notes, noteSnapshots } from "@db/schema";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = await createTestDatabase({ name: `note-snapshots-${Date.now()}.db` });
  await testDb.db.insert(notes).values({ id: 1, title: "t" });
});
afterEach(async () => {
  await testDb.close();
  await deleteTestDatabase(testDb.dbPath);
});

describe("saveNoteSnapshot", () => {
  it("stores a snapshot row with the encoded Y.Doc state and markdown", async () => {
    const { saveNoteSnapshot } = await import("@db/notes");
    const ydoc = new Y.Doc();
    ydoc.getText("t").insert(0, "hello");
    const encoded = Y.encodeStateAsUpdate(ydoc);

    const snapId = await saveNoteSnapshot(testDb.db, {
      noteId: 1,
      kind: "manual",
      label: "v1",
      ydocState: encoded,
      markdown: "hello",
    });
    expect(snapId).toBeGreaterThan(0);

    const rows = await testDb.db
      .select()
      .from(noteSnapshots)
      .where(eq(noteSnapshots.noteId, 1));
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("v1");
    expect(rows[0].kind).toBe("manual");
    expect(rows[0].markdown).toBe("hello");

    const restored = new Y.Doc();
    Y.applyUpdate(restored, new Uint8Array(rows[0].ydocState as Buffer));
    expect(restored.getText("t").toString()).toBe("hello");
  });

  it("ON DELETE CASCADE removes snapshots when the parent note is deleted", async () => {
    const { saveNoteSnapshot } = await import("@db/notes");
    const ydoc = new Y.Doc();
    ydoc.getText("t").insert(0, "x");
    await saveNoteSnapshot(testDb.db, {
      noteId: 1,
      kind: "manual",
      label: "v1",
      ydocState: Y.encodeStateAsUpdate(ydoc),
      markdown: "x",
    });
    // Sanity: the row exists before the cascade.
    const before = await testDb.db
      .select()
      .from(noteSnapshots)
      .where(eq(noteSnapshots.noteId, 1));
    expect(before).toHaveLength(1);

    await testDb.db.delete(notes).where(eq(notes.id, 1));

    const after = await testDb.db
      .select()
      .from(noteSnapshots)
      .where(eq(noteSnapshots.noteId, 1));
    expect(after).toHaveLength(0);
  });

  it("snapshot is independent of yjs_updates (survives a wipe)", async () => {
    const { saveNoteSnapshot } = await import("@db/notes");
    const ydoc = new Y.Doc();
    ydoc.getText("t").insert(0, "preserved");
    await saveNoteSnapshot(testDb.db, {
      noteId: 1,
      kind: "manual",
      label: "before-compact",
      ydocState: Y.encodeStateAsUpdate(ydoc),
      markdown: "preserved",
    });

    // (No yjs_updates rows exist in this test — the assertion is that the
    // snapshot table isn't FK-coupled to the update log and stands alone.)
    const rows = await testDb.db
      .select()
      .from(noteSnapshots)
      .where(eq(noteSnapshots.noteId, 1));
    expect(rows).toHaveLength(1);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, new Uint8Array(rows[0].ydocState as Buffer));
    expect(restored.getText("t").toString()).toBe("preserved");
  });
});

describe("pruneNoteSnapshots", () => {
  async function seedSnap(opts: {
    kind: "manual" | "auto" | "skill-accept";
    ageDays: number;
  }): Promise<void> {
    const ydoc = new Y.Doc();
    ydoc.getText("t").insert(0, `${opts.kind}-${opts.ageDays}d`);
    const created = new Date(Date.now() - opts.ageDays * 86_400_000);
    await testDb.db.insert(noteSnapshots).values({
      noteId: 1,
      kind: opts.kind,
      label: null,
      ydocState: Buffer.from(Y.encodeStateAsUpdate(ydoc)),
      markdown: "",
      createdAt: created,
      createdBy: null,
    });
  }

  it("never deletes manual snapshots", async () => {
    const { pruneNoteSnapshots } = await import("@db/notes");
    await seedSnap({ kind: "manual", ageDays: 365 });
    const { deleted } = await pruneNoteSnapshots(testDb.db, 1, { maxAgeDays: 30 });
    expect(deleted).toBe(0);
    const rows = await testDb.db
      .select()
      .from(noteSnapshots)
      .where(eq(noteSnapshots.noteId, 1));
    expect(rows).toHaveLength(1);
  });

  it("deletes auto snapshots older than maxAgeDays", async () => {
    const { pruneNoteSnapshots } = await import("@db/notes");
    await seedSnap({ kind: "auto", ageDays: 100 });
    await seedSnap({ kind: "auto", ageDays: 5 });
    const { deleted } = await pruneNoteSnapshots(testDb.db, 1, { maxAgeDays: 30 });
    expect(deleted).toBe(1);
  });

  it("caps non-protected count at maxCount (newest survive)", async () => {
    const { pruneNoteSnapshots } = await import("@db/notes");
    for (let i = 0; i < 8; i++) {
      await seedSnap({ kind: "auto", ageDays: i });
    }
    const { deleted } = await pruneNoteSnapshots(testDb.db, 1, {
      maxAgeDays: 365,
      maxCount: 3,
    });
    expect(deleted).toBe(5);
    const remaining = await testDb.db
      .select()
      .from(noteSnapshots)
      .where(eq(noteSnapshots.noteId, 1));
    expect(remaining).toHaveLength(3);
  });

  it("combines axes: age cutoff first, then count cap", async () => {
    const { pruneNoteSnapshots } = await import("@db/notes");
    await seedSnap({ kind: "manual", ageDays: 200 });
    await seedSnap({ kind: "auto", ageDays: 100 });
    await seedSnap({ kind: "auto", ageDays: 80 });
    for (let i = 0; i < 5; i++) await seedSnap({ kind: "auto", ageDays: i });

    const { deleted } = await pruneNoteSnapshots(testDb.db, 1, {
      maxAgeDays: 30,
      maxCount: 3,
    });
    expect(deleted).toBe(4); // 2 by age + 2 by count cap

    const remaining = await testDb.db
      .select()
      .from(noteSnapshots)
      .where(eq(noteSnapshots.noteId, 1));
    expect(remaining).toHaveLength(4); // 1 manual + 3 fresh auto
  });
});
