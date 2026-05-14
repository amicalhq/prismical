import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import {
  createTestDatabase,
  deleteTestDatabase,
  type TestDatabase,
} from "../helpers/test-db";
import { notes, yjsUpdates } from "@db/schema";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = await createTestDatabase({ name: `yjs-compaction-${Date.now()}.db` });
});
afterEach(async () => {
  await testDb.close();
  await deleteTestDatabase(testDb.dbPath);
});

// A single shared doc whose state we advance with each insert so that all
// updates share the same clientId and their positions are deterministic.
function makeUpdateSequence(tokens: string[]): Uint8Array[] {
  const d = new Y.Doc();
  return tokens.map((token) => {
    const before = Y.encodeStateVector(d);
    d.getText("t").insert(d.getText("t").length, token);
    return Y.encodeStateAsUpdate(d, before);
  });
}

describe("compactUpToId", () => {
  it("preserves tail rows inserted concurrently with compaction", async () => {
    const { saveYjsUpdate, compactUpToId } = await import("@db/notes");

    // Insert the parent note
    await testDb.db.insert(notes).values({ id: 1, title: "t" });

    // Seed 5 update rows using a shared sequence so ordering is deterministic
    const allUpdates = makeUpdateSequence(["a", "b", "c", "d", "e", "f"]);
    const first5 = allUpdates.slice(0, 5);
    const tailUpdate = allUpdates[5];

    for (const update of first5) {
      await saveYjsUpdate(testDb.db, 1, update);
    }

    // maxId MUST be captured before the tail insert; capturing after would include the tail in the DELETE range, defeating the race-safety guarantee.
    // Read maxId from the table (the high-watermark)
    const rows = await testDb.db
      .select({ id: yjsUpdates.id })
      .from(yjsUpdates)
      .where(eq(yjsUpdates.noteId, 1));
    const maxId = Math.max(...rows.map((r) => r.id));

    // Build a compacted snapshot Y.Doc from those 5 updates
    const allRows = await testDb.db
      .select()
      .from(yjsUpdates)
      .where(eq(yjsUpdates.noteId, 1));
    const snapshotDoc = new Y.Doc();
    for (const row of allRows) {
      Y.applyUpdate(snapshotDoc, new Uint8Array(row.updateData as Buffer));
    }
    const compactedSnapshot = Y.encodeStateAsUpdate(snapshotDoc);

    // Insert a 6th "tail" row (simulating concurrent renderer write)
    await saveYjsUpdate(testDb.db, 1, tailUpdate);

    // Run compaction up to the watermark
    await compactUpToId(testDb.db, 1, maxId, compactedSnapshot);

    // Assert: 2 rows remain (1 compacted + 1 tail)
    const remaining = await testDb.db
      .select()
      .from(yjsUpdates)
      .where(eq(yjsUpdates.noteId, 1));
    expect(remaining).toHaveLength(2);

    // Assert: replaying both rows yields same text as applying all 6 original updates
    const replayDoc = new Y.Doc();
    for (const row of remaining) {
      Y.applyUpdate(replayDoc, new Uint8Array(row.updateData as Buffer));
    }

    // Build expected Y.Doc from all 6 original updates applied sequentially
    const expectedDoc = new Y.Doc();
    for (const update of allUpdates) {
      Y.applyUpdate(expectedDoc, update);
    }

    expect(replayDoc.getText("t").toString()).toBe(
      expectedDoc.getText("t").toString(),
    );
  });

  it("collapses to 1 row when no concurrent writes happen", async () => {
    const { saveYjsUpdate, compactUpToId } = await import("@db/notes");

    await testDb.db.insert(notes).values({ id: 1, title: "t" });

    // Seed 3 updates
    const updates = makeUpdateSequence(["x", "y", "z"]);
    for (const update of updates) {
      await saveYjsUpdate(testDb.db, 1, update);
    }

    // Capture maxId
    const rows = await testDb.db
      .select({ id: yjsUpdates.id })
      .from(yjsUpdates)
      .where(eq(yjsUpdates.noteId, 1));
    const maxId = Math.max(...rows.map((r) => r.id));

    // Build snapshot
    const allRows = await testDb.db
      .select()
      .from(yjsUpdates)
      .where(eq(yjsUpdates.noteId, 1));
    const snapshotDoc = new Y.Doc();
    for (const row of allRows) {
      Y.applyUpdate(snapshotDoc, new Uint8Array(row.updateData as Buffer));
    }
    const compactedSnapshot = Y.encodeStateAsUpdate(snapshotDoc);

    // Compact (no concurrent writes)
    await compactUpToId(testDb.db, 1, maxId, compactedSnapshot);

    // Assert exactly 1 row remains
    const remaining = await testDb.db
      .select()
      .from(yjsUpdates)
      .where(eq(yjsUpdates.noteId, 1));
    expect(remaining).toHaveLength(1);
  });
});
