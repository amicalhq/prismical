import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  createTestDatabase,
  deleteTestDatabase,
  type TestDatabase,
} from "../../helpers/test-db";
import { setTestDatabase } from "../../setup";
import { notes, skills, instances, artifacts } from "@db/schema";
import type { SkillRunContext } from "@/services/skills-runtime/skill-context";
import { SkillCancelledError, WriteToolMissingError } from "@/services/skills-runtime/errors";

// ---------------------------------------------------------------------------
// Mock generateText from "ai" — the mock simulates the agent calling
// write_section with canned markdown.
// ---------------------------------------------------------------------------
vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("ai")>();
  return {
    ...original,
    generateText: vi.fn(),
  };
});

// Mock @ai-sdk/openai-compatible — we don't want real HTTP calls
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => (modelId: string) => ({
    specificationVersion: "v1",
    provider: "openai-compatible",
    modelId,
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CANNED_MARKDOWN = "## Summary\n\nAgent-generated content.";
const INSTANCE_ID = "test-instance-id";
const MODEL_ID = "gpt-4o-mini";
const NOTE_TITLE = "Test Note";

async function insertFixtures(db: TestDatabase["db"]) {
  const [note] = await db
    .insert(notes)
    .values({
      title: NOTE_TITLE,
      content: JSON.stringify({
        root: {
          children: [
            { type: "paragraph", children: [{ type: "text", text: "note body" }] },
          ],
          type: "root",
          version: 1,
          direction: null,
          format: "",
          indent: 0,
        },
      }),
    })
    .returning();

  const [skill] = await db
    .insert(skills)
    .values({
      id: "skill-test-id",
      slug: "enhance",
      name: "Enhance",
      body: "You are an AI assistant that enhances notes.",
      config: { editingOptions: "append-section", surface: ["dock"] },
      metadata: {},
    })
    .returning();

  const [instance] = await db
    .insert(instances)
    .values({
      id: INSTANCE_ID,
      provider: "openai-compatible",
      label: "Test Instance",
      config: { apiKey: "fake-key", baseURL: "http://fake-llm.local/v1" },
    })
    .returning();

  return { note, skill, instance };
}

function makeCtx(
  overrides: Partial<SkillRunContext> & Pick<SkillRunContext, "skill" | "noteId">,
): SkillRunContext {
  return {
    mode: "append-section",
    modelInstanceId: INSTANCE_ID,
    modelId: MODEL_ID,
    signal: new AbortController().signal,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let testDb: TestDatabase;
let testCounter = 0;
let generateTextMock: MockInstance;

beforeEach(async () => {
  testDb = await createTestDatabase({ name: `skill-runner-${Date.now()}-${testCounter++}.db` });
  setTestDatabase(testDb.db);

  // Get the mock reference after modules are loaded
  const aiModule = await import("ai");
  generateTextMock = aiModule.generateText as unknown as MockInstance;
});

afterEach(async () => {
  vi.resetAllMocks();
  await testDb.close();
  await deleteTestDatabase(testDb.dbPath);
});

describe("skills-runtime/skill-runner", () => {
  it("happy path: agent calls write_section → returns SkillRunResult with expected fields and writes audit row", async () => {
    const { runSkill } = await import("@/services/skills-runtime/skill-runner");
    const { note, skill } = await insertFixtures(testDb.db);

    // Configure mock to simulate agent calling write_section
    generateTextMock.mockImplementation(async (opts: { tools?: Record<string, { execute: (input: unknown, ctx: unknown) => Promise<unknown> }> }) => {
      const writeTool = opts.tools?.write_section;
      if (writeTool?.execute) {
        await writeTool.execute(
          { markdown: CANNED_MARKDOWN },
          { toolCallId: "mock-tool-call", messages: [], abortSignal: new AbortController().signal },
        );
      }
      return { text: "", steps: [], toolCalls: [], toolResults: [] };
    });

    const ctx = makeCtx({ skill, noteId: note.id });
    const result = await runSkill(ctx, { db: testDb.db });

    expect(result.skillId).toBe("enhance");
    expect(result.skillName).toBe("Enhance");
    expect(result.mode).toBe("append-section");
    expect(result.modelId).toBe(MODEL_ID);
    expect(result.rawMarkdown).toBe(CANNED_MARKDOWN);
    expect(result.content).toBeInstanceOf(Array);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.artifactId).toBeTruthy();
    expect(result.version).toBeGreaterThan(0);
    expect(result.generatedAt).toBeTruthy();

    // Verify the audit row was written
    const rows = await testDb.db.select().from(artifacts).all();
    expect(rows.length).toBe(1);
    expect(rows[0].skillId).toBe("enhance");
    expect(rows[0].mode).toBe("append-section");
    expect(rows[0].noteId).toBe(note.id);
    expect(rows[0].modelId).toBe(MODEL_ID);
  });

  it("cancellation: aborted signal before call → throws SkillCancelledError", async () => {
    const { runSkill } = await import("@/services/skills-runtime/skill-runner");
    const { note, skill } = await insertFixtures(testDb.db);

    const controller = new AbortController();
    controller.abort(); // pre-abort

    // Mock generateText to throw an AbortError (simulating what the SDK does on abort)
    generateTextMock.mockImplementation(async () => {
      throw new DOMException("Aborted", "AbortError");
    });

    const ctx = makeCtx({ skill, noteId: note.id, signal: controller.signal });

    await expect(runSkill(ctx, { db: testDb.db })).rejects.toThrow(SkillCancelledError);
  });

  it("tool-missing: mock never calls write_section → throws WriteToolMissingError", async () => {
    const { runSkill } = await import("@/services/skills-runtime/skill-runner");
    const { note, skill } = await insertFixtures(testDb.db);

    // Mock generateText to return without calling any tool
    generateTextMock.mockResolvedValue({
      text: "I decided not to write anything.",
      steps: [],
      toolCalls: [],
      toolResults: [],
    });

    const ctx = makeCtx({ skill, noteId: note.id });

    await expect(runSkill(ctx, { db: testDb.db })).rejects.toThrow(WriteToolMissingError);
  });

  it("mode override: ctx.mode=replace-doc writes audit row with mode=replace-doc", async () => {
    const { runSkill } = await import("@/services/skills-runtime/skill-runner");
    const { note, skill } = await insertFixtures(testDb.db);

    generateTextMock.mockImplementation(async (opts: { tools?: Record<string, { execute: (input: unknown, ctx: unknown) => Promise<unknown> }> }) => {
      const writeTool = opts.tools?.write_section;
      if (writeTool?.execute) {
        await writeTool.execute(
          { markdown: "# Full replacement\n\nContent here." },
          { toolCallId: "mock-tool-call", messages: [], abortSignal: new AbortController().signal },
        );
      }
      return { text: "", steps: [], toolCalls: [], toolResults: [] };
    });

    // skill.config.editingOptions is "append-section" but ctx.mode overrides to "replace-doc"
    const ctx = makeCtx({ skill, noteId: note.id, mode: "replace-doc" });
    const result = await runSkill(ctx, { db: testDb.db });

    expect(result.mode).toBe("replace-doc");

    const rows = await testDb.db.select().from(artifacts).all();
    expect(rows.length).toBe(1);
    expect(rows[0].mode).toBe("replace-doc");
  });

  it("cancellation: signal aborted during generateText → throws SkillCancelledError", async () => {
    const { runSkill } = await import("@/services/skills-runtime/skill-runner");
    const { note, skill } = await insertFixtures(testDb.db);

    const controller = new AbortController();

    generateTextMock.mockImplementation(async () => {
      // Abort mid-execution and then throw
      controller.abort();
      throw new Error("Request aborted");
    });

    const ctx = makeCtx({ skill, noteId: note.id, signal: controller.signal });

    await expect(runSkill(ctx, { db: testDb.db })).rejects.toThrow(SkillCancelledError);
  });

  it("uses replace_selection tool when mode is inline-rewrite", async () => {
    const { runSkill } = await import("@/services/skills-runtime/skill-runner");
    const { note, skill } = await insertFixtures(testDb.db);

    let calledToolName: string | null = null;

    generateTextMock.mockImplementation(async (opts: { tools?: Record<string, { execute: (input: unknown, ctx: unknown) => Promise<unknown> }> }) => {
      // inline-rewrite mode should expose replace_selection, not write_section
      const replaceTool = opts.tools?.replace_selection;
      const writeTool = opts.tools?.write_section;
      expect(replaceTool).toBeDefined();
      expect(writeTool).toBeUndefined();

      if (replaceTool?.execute) {
        calledToolName = "replace_selection";
        await replaceTool.execute(
          { markdown: "rewritten content" },
          { toolCallId: "mock-tool-call", messages: [], abortSignal: new AbortController().signal },
        );
      }
      return { text: "", steps: [], toolCalls: [], toolResults: [] };
    });

    const ctx = makeCtx({
      skill,
      noteId: note.id,
      mode: "inline-rewrite",
      selectionText: "original selected text",
    });

    const result = await runSkill(ctx, { db: testDb.db });
    expect(calledToolName).toBe("replace_selection");
    expect(result.mode).toBe("inline-rewrite");
    expect(result.rawMarkdown).toBe("rewritten content");
  });
});
