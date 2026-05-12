import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  deleteTestDatabase,
  type TestDatabase,
} from "../../../helpers/test-db";
import { notes } from "@db/schema";

let testDb: TestDatabase;
let testCounter = 0;

beforeEach(async () => {
  testDb = await createTestDatabase({ name: `read-note-${Date.now()}-${testCounter++}.db` });
});
afterEach(async () => {
  await testDb.close();
  await deleteTestDatabase(testDb.dbPath);
});

describe("skills-runtime/tools/read-note", () => {
  it("returns title + body text for the note", async () => {
    const { createReadNoteTool } = await import(
      "@/services/skills-runtime/tools/read-note"
    );
    const [note] = await testDb.db
      .insert(notes)
      .values({
        title: "Q2 sales call",
        content: JSON.stringify({
          root: {
            children: [
              {
                type: "paragraph",
                children: [{ type: "text", text: "hello world" }],
              },
            ],
            direction: null,
            format: "",
            indent: 0,
            type: "root",
            version: 1,
          },
        }),
      })
      .returning();

    const tool = createReadNoteTool({ db: testDb.db, noteId: note.id });
    const result = await tool.execute(
      {},
      { toolCallId: "t1", messages: [], abortSignal: new AbortController().signal },
    );
    expect(result.title).toBe("Q2 sales call");
    expect(result.body).toContain("hello world");
  });

  it("returns empty body when notes.content is null or empty", async () => {
    const { createReadNoteTool } = await import(
      "@/services/skills-runtime/tools/read-note"
    );
    const [note] = await testDb.db
      .insert(notes)
      .values({ title: "Empty", content: "" })
      .returning();
    const tool = createReadNoteTool({ db: testDb.db, noteId: note.id });
    const result = await tool.execute(
      {},
      { toolCallId: "t2", messages: [], abortSignal: new AbortController().signal },
    );
    expect(result.body).toBe("");
  });
});
