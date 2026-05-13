import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "@db/schema";
import path from "node:path";
import os from "node:os";
import fs from "fs-extra";
import { type TestDatabase } from "../../helpers/test-db";
import { setTestDatabase } from "../../setup";
import { notes, skills, instances, artifacts } from "@db/schema";
import type { SkillRunContext } from "@/services/skills-runtime/skill-context";
import { SkillCancelledError, SkillRunError } from "@/services/skills-runtime/errors";

// Mock `generateText` from `ai`. The runner asks for a structured output
// via `Output.object`; the mock returns a fake result with the typed
// `output` field already populated. We never exercise the real Output
// pipeline here — that's covered by integration tests against a live
// model — so we can hand back the plain object directly.
vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("ai")>();
  return {
    ...original,
    generateText: vi.fn(),
  };
});

// Mock the openai-compatible provider so we don't make HTTP calls.
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => (modelId: string) => ({
    specificationVersion: "v3",
    provider: "openai-compatible",
    modelId,
  })),
}));

const CANNED_MARKDOWN = "## Summary\n\nModel-generated content.";
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

let testDb: TestDatabase;
let generateTextMock: MockInstance;

async function createIsolatedTestDb(): Promise<TestDatabase> {
  const { randomUUID } = await import("crypto");
  const dbDir = path.join(os.tmpdir(), `skill-runner-isolated-${randomUUID()}`);
  await fs.ensureDir(dbDir);
  const dbPath = path.join(dbDir, "test.db");
  const db = drizzle(`file:${dbPath}`, { schema: { ...schema } });
  await db.$client.execute("PRAGMA foreign_keys = ON");
  const migrationsPath = path.join(process.cwd(), "src", "db", "migrations");
  await migrate(db, { migrationsFolder: migrationsPath });
  return {
    db,
    dbPath,
    close: async () => { db.$client.close(); },
    clear: async () => {},
  };
}

beforeEach(async () => {
  testDb = await createIsolatedTestDb();
  setTestDatabase(testDb.db);

  const aiModule = await import("ai");
  generateTextMock = aiModule.generateText as unknown as MockInstance;
});

afterEach(async () => {
  vi.resetAllMocks();
  await testDb.close();
  await fs.remove(path.dirname(testDb.dbPath));
});

describe("skills-runtime/skill-runner", () => {
  it("happy path: model returns structured object → runner emits an unpersisted SkillRunResult", async () => {
    const { runSkill } = await import("@/services/skills-runtime/skill-runner");
    const { note, skill } = await insertFixtures(testDb.db);

    generateTextMock.mockResolvedValue({
      output: { markdown: CANNED_MARKDOWN },
    });

    const result = await runSkill(makeCtx({ skill, noteId: note.id }), {
      db: testDb.db,
    });

    expect(result.skillId).toBe("enhance");
    expect(result.skillName).toBe("Enhance");
    expect(result.mode).toBe("append-section");
    expect(result.modelId).toBe(MODEL_ID);
    expect(result.modelInstanceId).toBe(INSTANCE_ID);
    expect(result.providerType).toBe("openai-compatible");
    expect(result.rawMarkdown).toBe(CANNED_MARKDOWN);
    expect(result.content.length).toBeGreaterThan(0);

    // Spec §1+§2: the runner MUST NOT write the audit row. Accept does that.
    const rows = await testDb.db.select().from(artifacts).all();
    expect(rows.length).toBe(0);
  });

  it("pre-injects note + system prompt: generateText receives a system string containing the note body", async () => {
    const { runSkill } = await import("@/services/skills-runtime/skill-runner");
    const { note, skill } = await insertFixtures(testDb.db);

    generateTextMock.mockResolvedValue({
      output: { markdown: CANNED_MARKDOWN },
    });

    await runSkill(makeCtx({ skill, noteId: note.id }), { db: testDb.db });

    const callArgs = generateTextMock.mock.calls[0][0] as { system: string };
    expect(callArgs.system).toContain("note body");
    expect(callArgs.system).toContain("Active mode: append-section");
  });

  it("inline-rewrite: selection text is injected into the system prompt", async () => {
    const { runSkill } = await import("@/services/skills-runtime/skill-runner");
    const { note, skill } = await insertFixtures(testDb.db);

    generateTextMock.mockResolvedValue({
      output: { markdown: "rewritten" },
    });

    await runSkill(
      makeCtx({
        skill,
        noteId: note.id,
        mode: "inline-rewrite",
        selectionText: "original selected text",
      }),
      { db: testDb.db },
    );

    const callArgs = generateTextMock.mock.calls[0][0] as { system: string };
    expect(callArgs.system).toContain("Selected text to rewrite");
    expect(callArgs.system).toContain("original selected text");
  });

  it("cancellation: aborted signal → throws SkillCancelledError", async () => {
    const { runSkill } = await import("@/services/skills-runtime/skill-runner");
    const { note, skill } = await insertFixtures(testDb.db);

    const controller = new AbortController();
    controller.abort();

    generateTextMock.mockImplementation(async () => {
      throw new DOMException("Aborted", "AbortError");
    });

    await expect(
      runSkill(makeCtx({ skill, noteId: note.id, signal: controller.signal }), {
        db: testDb.db,
      }),
    ).rejects.toThrow(SkillCancelledError);
  });

  it("empty markdown: model returns content that produces no Lexical children → SkillRunError", async () => {
    const { runSkill } = await import("@/services/skills-runtime/skill-runner");
    const { note, skill } = await insertFixtures(testDb.db);

    generateTextMock.mockResolvedValue({ output: { markdown: "   \n  " } });

    await expect(
      runSkill(makeCtx({ skill, noteId: note.id }), { db: testDb.db }),
    ).rejects.toThrow(SkillRunError);
  });

  it("mode override: ctx.mode=replace-doc populates beforeText with the note's markdown rendering; still no audit row written", async () => {
    const { runSkill } = await import("@/services/skills-runtime/skill-runner");
    const { note, skill } = await insertFixtures(testDb.db);

    generateTextMock.mockResolvedValue({
      output: { markdown: "# Full replacement\n\nContent here." },
    });

    const result = await runSkill(
      makeCtx({ skill, noteId: note.id, mode: "replace-doc" }),
      { db: testDb.db },
    );

    expect(result.mode).toBe("replace-doc");
    expect(result.beforeText).toContain("note body");

    const rows = await testDb.db.select().from(artifacts).all();
    expect(rows.length).toBe(0);
  });
});
