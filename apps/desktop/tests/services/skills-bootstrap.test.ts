import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  deleteTestDatabase,
  type TestDatabase,
} from "../helpers/test-db";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = await createTestDatabase({
    name: `skills-bootstrap-${Date.now()}.db`,
  });
});
afterEach(async () => {
  await testDb.close();
  await deleteTestDatabase(testDb.dbPath);
});

describe("services/skills-bootstrap", () => {
  it("seeds enhance + cleanup with the expected shape", async () => {
    const { bootstrapSkills } = await import("@/services/skills-bootstrap");
    const { getSkillBySlug } = await import("@db/skills");
    await bootstrapSkills(testDb.db);

    const enhance = await getSkillBySlug(testDb.db, "enhance");
    expect(enhance).not.toBeNull();
    expect(enhance!.name).toBe("Enhance");
    expect(enhance!.system).toBe(true);
    expect(enhance!.enabled).toBe(true);
    expect(enhance!.body).toMatch(/write_section/);
    expect(enhance!.body).toMatch(/read_note/);
    expect(enhance!.config.editingOptions).toBe("append-section");
    expect(enhance!.config.surface.sort()).toEqual(["dock", "inline"]);
    expect(enhance!.config.defaultSkill).toBe(true);

    const cleanup = await getSkillBySlug(testDb.db, "cleanup");
    expect(cleanup).not.toBeNull();
    expect(cleanup!.name).toBe("Cleanup");
    expect(cleanup!.system).toBe(true);
    expect(cleanup!.config.editingOptions).toBe("replace-doc");
    expect(cleanup!.config.surface).toEqual(["dock"]);
    expect(cleanup!.config.defaultSkill ?? false).toBe(false);
  });

  it("is idempotent — running twice does not duplicate or mutate seeded rows", async () => {
    const { bootstrapSkills } = await import("@/services/skills-bootstrap");
    const { listSkills, getSkillBySlug } = await import("@db/skills");
    await bootstrapSkills(testDb.db);
    const firstBody = (await getSkillBySlug(testDb.db, "enhance"))!.body;
    await bootstrapSkills(testDb.db);
    const all = await listSkills(testDb.db, {});
    expect(all.map((s) => s.slug).sort()).toEqual(["cleanup", "enhance"]);
    const secondBody = (await getSkillBySlug(testDb.db, "enhance"))!.body;
    expect(secondBody).toBe(firstBody);
  });

  it("exactly one seeded skill has defaultSkill=true (sparkle target invariant)", async () => {
    const { bootstrapSkills } = await import("@/services/skills-bootstrap");
    const { listSkills } = await import("@db/skills");
    await bootstrapSkills(testDb.db);
    const all = await listSkills(testDb.db, {});
    const defaults = all.filter((s) => s.config.defaultSkill === true);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].slug).toBe("enhance");
  });
});
