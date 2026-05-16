import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "fs-extra";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "@db/schema";
import { instances } from "@db/schema";
import { type TestDatabase } from "../../helpers/test-db";
import { setTestDatabase } from "../../setup";

// Stub the network-bound SDK factories so registry construction never
// performs an HTTP call. Each returns a ProviderV3-shaped object with the
// `languageModel(id)` method the registry expects.
function fakeProvider(name: string) {
  return {
    specificationVersion: "v3" as const,
    languageModel: (modelId: string) => ({
      specificationVersion: "v3" as const,
      provider: name,
      modelId,
    }),
  };
}

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => fakeProvider("openai")),
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => fakeProvider("anthropic")),
}));
vi.mock("@ai-sdk/groq", () => ({
  createGroq: vi.fn(() => fakeProvider("groq")),
}));
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn((opts: { name: string }) =>
    fakeProvider(opts.name ?? "openai-compatible"),
  ),
}));
vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: vi.fn(() => fakeProvider("openrouter")),
}));

let testDb: TestDatabase;

async function createIsolatedTestDb(): Promise<TestDatabase> {
  const { randomUUID } = await import("crypto");
  const dbDir = path.join(os.tmpdir(), `registry-test-${randomUUID()}`);
  await fs.ensureDir(dbDir);
  const dbPath = path.join(dbDir, "test.db");
  const db = drizzle(`file:${dbPath}`, { schema: { ...schema } });
  await db.$client.execute("PRAGMA foreign_keys = ON");
  const migrationsPath = path.join(process.cwd(), "src", "db", "migrations");
  await migrate(db, { migrationsFolder: migrationsPath });
  return {
    db,
    dbPath,
    close: async () => {
      db.$client.close();
    },
    clear: async () => {},
  };
}

beforeEach(async () => {
  testDb = await createIsolatedTestDb();
  setTestDatabase(testDb.db);
});

afterEach(async () => {
  vi.clearAllMocks();
  await testDb.close();
  await fs.remove(path.dirname(testDb.dbPath));
});

describe("services/ai/registry", () => {
  it("filters out rows whose provider has no factory entry (e.g. local-whisper, coming-soon types)", async () => {
    // `local-whisper` is intentionally absent from providerFactories — the
    // registry build skips it silently. Similarly an unknown / coming-soon
    // provider string never reaches the factory call.
    await testDb.db.insert(instances).values([
      {
        id: "inst-openai",
        provider: "openai",
        label: "OpenAI",
        config: { apiKey: "sk-test" },
      },
      {
        id: "inst-whisper",
        provider: "local-whisper",
        label: "Local whisper",
        config: { downloadedModels: [] },
      },
      {
        id: "inst-coming-soon",
        provider: "cerebras",
        label: "Cerebras",
        config: { apiKey: "x" },
      },
    ]);

    const { getRegistry } = await import("@/services/ai/registry");
    const registry = await getRegistry();

    // Resolvable
    const openAIModel = registry.languageModel("inst-openai::gpt-4o-mini");
    expect(openAIModel.modelId).toBe("gpt-4o-mini");

    // Filtered: throws NoSuchProvider — these never made it into the registry.
    expect(() => registry.languageModel("inst-whisper::ggml-tiny")).toThrow();
    expect(() => registry.languageModel("inst-coming-soon::any")).toThrow();
  });

  it("two OpenAI instances resolve to two distinct providers", async () => {
    await testDb.db.insert(instances).values([
      {
        id: "inst-personal",
        provider: "openai",
        label: "Personal OpenAI",
        config: { apiKey: "sk-personal" },
      },
      {
        id: "inst-work",
        provider: "openai",
        label: "Work OpenAI",
        config: { apiKey: "sk-work" },
      },
    ]);

    const { getRegistry, registryKey } = await import("@/services/ai/registry");
    const registry = await getRegistry();

    const personal = registry.languageModel(
      registryKey("inst-personal", "gpt-4o"),
    );
    const work = registry.languageModel(registryKey("inst-work", "gpt-4o"));

    // Both resolve, both report the same provider name (the underlying
    // SDK provider id), but they are distinct object instances built from
    // different config — confirming the registry keys by instance.id.
    expect(personal.modelId).toBe("gpt-4o");
    expect(work.modelId).toBe("gpt-4o");
    expect(personal).not.toBe(work);
  });

  it("returns a fresh registry on each call (no cache)", async () => {
    await testDb.db.insert(instances).values({
      id: "inst-key-rotation",
      provider: "openai",
      label: "Rotating key",
      config: { apiKey: "sk-old" },
    });
    const { getRegistry } = await import("@/services/ai/registry");
    const reg1 = await getRegistry();

    // Mutate the API key — next getRegistry build sees the new value via
    // the factory call. We don't assert against the underlying key (it's
    // hidden inside the stub) — we just confirm the registry is freshly
    // built and the model id still resolves through.
    await testDb.db
      .update(instances)
      .set({ config: { apiKey: "sk-new" } })
      .where(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (await import("drizzle-orm")).eq(instances.id, "inst-key-rotation"),
      );
    const reg2 = await getRegistry();

    expect(reg1).not.toBe(reg2);
    expect(reg2.languageModel("inst-key-rotation::gpt-4o").modelId).toBe(
      "gpt-4o",
    );
  });
});
