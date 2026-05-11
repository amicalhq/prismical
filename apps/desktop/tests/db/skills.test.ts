import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  deleteTestDatabase,
  type TestDatabase,
} from "../helpers/test-db";
import type { SkillConfig } from "@db/schema";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = await createTestDatabase({ name: `skills-db-${Date.now()}.db` });
});
afterEach(async () => {
  await testDb.close();
  await deleteTestDatabase(testDb.dbPath);
});

const baseConfig: SkillConfig = {
  editingOptions: "append-section",
  surface: ["dock"],
};

describe("db/skills", () => {
  it("createSkill persists and returns the row", async () => {
    const { createSkill } = await import("@db/skills");
    const row = await createSkill(testDb.db, {
      slug: "enhance",
      name: "Enhance",
      body: "prompt body",
      config: baseConfig,
      system: true,
    });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.slug).toBe("enhance");
    expect(row.system).toBe(true);
    expect(row.enabled).toBe(true);
    expect(row.version).toBe(1);
    expect(row.config).toEqual(baseConfig);
  });

  it("getSkillBySlug returns null when missing, row when present", async () => {
    const { createSkill, getSkillBySlug } = await import("@db/skills");
    expect(await getSkillBySlug(testDb.db, "absent")).toBeNull();
    await createSkill(testDb.db, {
      slug: "enhance",
      name: "Enhance",
      body: "x",
      config: baseConfig,
    });
    const got = await getSkillBySlug(testDb.db, "enhance");
    expect(got?.name).toBe("Enhance");
  });

  it("slug uniqueness is enforced at the DB level", async () => {
    const { createSkill } = await import("@db/skills");
    await createSkill(testDb.db, {
      slug: "enhance",
      name: "Enhance",
      body: "x",
      config: baseConfig,
    });
    await expect(
      createSkill(testDb.db, {
        slug: "enhance",
        name: "Other",
        body: "y",
        config: baseConfig,
      }),
    ).rejects.toThrow();
  });

  it("seedSkillIfMissing is idempotent — second call leaves the original row intact", async () => {
    const { seedSkillIfMissing, getSkillBySlug } = await import("@db/skills");
    await seedSkillIfMissing(testDb.db, {
      slug: "enhance",
      name: "Enhance",
      body: "first",
      config: baseConfig,
      system: true,
    });
    await seedSkillIfMissing(testDb.db, {
      slug: "enhance",
      name: "Enhance v2",
      body: "second",
      config: baseConfig,
      system: true,
    });
    const got = await getSkillBySlug(testDb.db, "enhance");
    expect(got?.body).toBe("first");
    expect(got?.name).toBe("Enhance");
  });

  it("listSkills returns enabled-only when opts.onlyEnabled=true", async () => {
    const { createSkill, updateSkill, listSkills } = await import("@db/skills");
    const a = await createSkill(testDb.db, {
      slug: "a",
      name: "A",
      body: "x",
      config: baseConfig,
    });
    await createSkill(testDb.db, {
      slug: "b",
      name: "B",
      body: "x",
      config: baseConfig,
    });
    await updateSkill(testDb.db, a.id, { enabled: false });

    const all = await listSkills(testDb.db, {});
    expect(all.map((s) => s.slug).sort()).toEqual(["a", "b"]);

    const enabledOnly = await listSkills(testDb.db, { onlyEnabled: true });
    expect(enabledOnly.map((s) => s.slug)).toEqual(["b"]);
  });

  it("listEnabledSkillsForSurface filters on config.surface JSON", async () => {
    const { createSkill, listEnabledSkillsForSurface } = await import(
      "@db/skills"
    );
    await createSkill(testDb.db, {
      slug: "dock-only",
      name: "Dock Only",
      body: "x",
      config: { editingOptions: "append-section", surface: ["dock"] },
    });
    await createSkill(testDb.db, {
      slug: "inline-only",
      name: "Inline Only",
      body: "x",
      config: { editingOptions: "inline-rewrite", surface: ["inline"] },
    });
    await createSkill(testDb.db, {
      slug: "both",
      name: "Both",
      body: "x",
      config: {
        editingOptions: "append-section",
        surface: ["dock", "inline"],
      },
    });

    const dock = await listEnabledSkillsForSurface(testDb.db, "dock");
    expect(dock.map((s) => s.slug).sort()).toEqual(["both", "dock-only"]);

    const inline = await listEnabledSkillsForSurface(testDb.db, "inline");
    expect(inline.map((s) => s.slug).sort()).toEqual(["both", "inline-only"]);
  });

  it("updateSkill bumps version and updatedAt", async () => {
    const { createSkill, updateSkill } = await import("@db/skills");
    const row = await createSkill(testDb.db, {
      slug: "x",
      name: "X",
      body: "first",
      config: baseConfig,
    });
    expect(row.version).toBe(1);
    const updated = await updateSkill(testDb.db, row.id, { body: "second" });
    expect(updated.version).toBe(2);
    expect(updated.body).toBe("second");
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
      row.updatedAt.getTime(),
    );
  });

  it("deleteSkill removes the row", async () => {
    const { createSkill, deleteSkill, getSkillBySlug } = await import(
      "@db/skills"
    );
    const row = await createSkill(testDb.db, {
      slug: "x",
      name: "X",
      body: "x",
      config: baseConfig,
    });
    await deleteSkill(testDb.db, row.id);
    expect(await getSkillBySlug(testDb.db, "x")).toBeNull();
  });
});
