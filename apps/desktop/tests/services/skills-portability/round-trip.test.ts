import { describe, expect, it } from "vitest";
import { skillToJson } from "@/services/skills-portability/skill-to-json";
import { skillFromJson } from "@/services/skills-portability/skill-from-json";
import type { Skill } from "@db/schema";

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "test-skill-id",
    slug: "my-skill",
    name: "My Skill",
    description: "A test skill",
    iconUrl: null,
    body: "You are a helpful assistant. Improve this text.",
    metadata: { author: "test-author", tags: ["writing"] },
    config: {
      editingOptions: "append-section",
      surface: ["dock"],
    },
    allowedTools: null,
    createdBy: null,
    orgId: null,
    system: false,
    public: false,
    featured: false,
    enabled: true,
    parentSkillId: null,
    version: 1,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

describe("JSON round-trip", () => {
  it("skillToJson preserves portable fields", () => {
    const skill = makeSkill();
    const json = skillToJson(skill);
    expect(json.slug).toBe("my-skill");
    expect(json.name).toBe("My Skill");
    expect(json.body).toBe("You are a helpful assistant. Improve this text.");
    expect(json.config.editingOptions).toBe("append-section");
    expect(json.config.surface).toEqual(["dock"]);
  });

  it("skillToJson does not include internal fields (id, createdAt, updatedAt)", () => {
    const skill = makeSkill();
    const json = skillToJson(skill) as Record<string, unknown>;
    expect(json.id).toBeUndefined();
    expect(json.createdAt).toBeUndefined();
    expect(json.updatedAt).toBeUndefined();
    expect(json.system).toBeUndefined();
  });

  it("round-trips through JSON serialization", () => {
    const skill = makeSkill();
    const exported = skillToJson(skill);
    const serialized = JSON.parse(JSON.stringify(exported));
    const imported = skillFromJson(serialized);
    expect(imported.slug).toBe(skill.slug);
    expect(imported.name).toBe(skill.name);
    expect(imported.body).toBe(skill.body);
    expect(imported.config.editingOptions).toBe(skill.config.editingOptions);
    expect(imported.config.surface).toEqual(skill.config.surface);
  });

  it("round-trips a skill with description and iconUrl", () => {
    const skill = makeSkill({ description: "Fancy description", iconUrl: "https://example.com/icon.png" });
    const exported = skillToJson(skill);
    const imported = skillFromJson(JSON.parse(JSON.stringify(exported)));
    expect(imported.description).toBe("Fancy description");
    expect(imported.iconUrl).toBe("https://example.com/icon.png");
  });

  it("skillFromJson throws on empty input", () => {
    expect(() => skillFromJson({})).toThrow();
  });

  it("skillFromJson throws when surface array is empty", () => {
    expect(() =>
      skillFromJson({
        slug: "x",
        name: "X",
        body: "some body",
        config: { editingOptions: "append-section", surface: [] },
      }),
    ).toThrow();
  });

  it("skillFromJson throws when body is missing", () => {
    expect(() =>
      skillFromJson({
        slug: "x",
        name: "X",
        config: { editingOptions: "append-section", surface: ["dock"] },
      }),
    ).toThrow();
  });

  it("skillFromJson throws when slug is missing", () => {
    expect(() =>
      skillFromJson({
        name: "X",
        body: "some body",
        config: { editingOptions: "append-section", surface: ["dock"] },
      }),
    ).toThrow();
  });
});
