import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  deleteTestDatabase,
  type TestDatabase,
} from "../../../helpers/test-db";
import { notes, meetings, transcriptSegments } from "@db/schema";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = await createTestDatabase({ name: `read-transcript-${Date.now()}.db` });
});
afterEach(async () => {
  await testDb.close();
  await deleteTestDatabase(testDb.dbPath);
});

describe("skills-runtime/tools/read-transcript", () => {
  it("returns concatenated transcript text in segment_order", async () => {
    const { createReadTranscriptTool } = await import(
      "@/services/skills-runtime/tools/read-transcript"
    );

    // Insert a note
    const [note] = await testDb.db
      .insert(notes)
      .values({ title: "Sales call" })
      .returning();

    // Insert a meeting linked to the note
    const meetingId = `meeting-test-${Date.now()}`;
    await testDb.db.insert(meetings).values({
      id: meetingId,
      noteId: note.id,
      title: "Sales call meeting",
      startedAt: new Date(),
      captureMode: "mic",
      state: "completed",
    });

    // Insert 3 transcript segments out of order to verify ordering
    await testDb.db.insert(transcriptSegments).values([
      {
        id: `seg-c-${Date.now()}`,
        meetingId,
        source: "mic",
        speaker: "you",
        text: "Third segment",
        startTimeMs: 2000,
        endTimeMs: 3000,
        segmentOrder: 3,
      },
      {
        id: `seg-a-${Date.now()}`,
        meetingId,
        source: "mic",
        speaker: "you",
        text: "First segment",
        startTimeMs: 0,
        endTimeMs: 1000,
        segmentOrder: 1,
      },
      {
        id: `seg-b-${Date.now()}`,
        meetingId,
        source: "mic",
        speaker: "them",
        text: "Second segment",
        startTimeMs: 1000,
        endTimeMs: 2000,
        segmentOrder: 2,
      },
    ]);

    const tool = createReadTranscriptTool({ db: testDb.db, noteId: note.id });
    const result = await tool.execute(
      {},
      { toolCallId: "t1", messages: [], abortSignal: new AbortController().signal },
    );

    expect(result.transcript).not.toBeNull();
    // Should be ordered by segment_order: first, second, third
    const lines = result.transcript!.split("\n");
    expect(lines[0]).toBe("First segment");
    expect(lines[1]).toBe("Second segment");
    expect(lines[2]).toBe("Third segment");
  });

  it("returns { transcript: null } when no meeting is linked to the note", async () => {
    const { createReadTranscriptTool } = await import(
      "@/services/skills-runtime/tools/read-transcript"
    );

    const [note] = await testDb.db
      .insert(notes)
      .values({ title: "Note without meeting" })
      .returning();

    const tool = createReadTranscriptTool({ db: testDb.db, noteId: note.id });
    const result = await tool.execute(
      {},
      { toolCallId: "t2", messages: [], abortSignal: new AbortController().signal },
    );

    expect(result.transcript).toBeNull();
  });
});
