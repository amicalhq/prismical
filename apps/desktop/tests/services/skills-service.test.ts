import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  deleteTestDatabase,
  type TestDatabase,
} from "../helpers/test-db";
import type { SkillConfig } from "@db/schema";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = await createTestDatabase({
    name: `skills-service-${Date.now()}.db`,
  });
});
afterEach(async () => {
  await testDb.close();
  await deleteTestDatabase(testDb.dbPath);
});

const baseConfig: SkillConfig = {
  editingOptions: "append-section",
  surface: ["dock"],
};

describe("services/skills-service", () => {
  it("createSkill rejects an invalid slug", async () => {
    const { SkillsService } = await import("@/services/skills-service");
    const svc = new SkillsService(testDb.db);
    await expect(
      svc.createSkill({
        slug: "Bad Slug!",
        name: "X",
        body: "x",
        config: baseConfig,
      }),
    ).rejects.toThrow(/slug/i);
  });

  it("createSkill rejects an empty name or body", async () => {
    const { SkillsService } = await import("@/services/skills-service");
    const svc = new SkillsService(testDb.db);
    await expect(
      svc.createSkill({ slug: "ok", name: "", body: "x", config: baseConfig }),
    ).rejects.toThrow(/name/i);
    await expect(
      svc.createSkill({ slug: "ok", name: "X", body: "", config: baseConfig }),
    ).rejects.toThrow(/body/i);
  });

  it("createSkill rejects empty surface array", async () => {
    const { SkillsService } = await import("@/services/skills-service");
    const svc = new SkillsService(testDb.db);
    await expect(
      svc.createSkill({
        slug: "ok",
        name: "X",
        body: "x",
        config: { editingOptions: "append-section", surface: [] },
      }),
    ).rejects.toThrow(/surface/i);
  });

  it("system skills cannot be deleted", async () => {
    const { SkillsService } = await import("@/services/skills-service");
    const svc = new SkillsService(testDb.db);
    const row = await svc.createSkill({
      slug: "enhance",
      name: "Enhance",
      body: "x",
      config: baseConfig,
      system: true,
    });
    await expect(svc.deleteSkill(row.id)).rejects.toThrow(/system/i);
  });

  it("system skills are fully read-only — disable, body, and config edits all rejected", async () => {
    const { SkillsService } = await import("@/services/skills-service");
    const svc = new SkillsService(testDb.db);
    const row = await svc.createSkill({
      slug: "enhance",
      name: "Enhance",
      body: "x",
      config: baseConfig,
      system: true,
    });
    await expect(
      svc.updateSkill(row.id, { enabled: false }),
    ).rejects.toThrow(/system/i);
    await expect(
      svc.updateSkill(row.id, { body: "rewritten prompt" }),
    ).rejects.toThrow(/system/i);
    await expect(
      svc.updateSkill(row.id, {
        config: { editingOptions: "replace-doc", surface: ["dock"] },
      }),
    ).rejects.toThrow(/system/i);
  });

  it("listForSurface returns enabled skills whose surface includes the target", async () => {
    const { SkillsService } = await import("@/services/skills-service");
    const svc = new SkillsService(testDb.db);
    await svc.createSkill({
      slug: "dock-only",
      name: "Dock Only",
      body: "x",
      config: { editingOptions: "append-section", surface: ["dock"] },
    });
    await svc.createSkill({
      slug: "inline-only",
      name: "Inline Only",
      body: "x",
      config: { editingOptions: "inline-rewrite", surface: ["inline"] },
    });
    const dock = await svc.listForSurface("dock");
    expect(dock.map((s) => s.slug)).toEqual(["dock-only"]);
  });
});
