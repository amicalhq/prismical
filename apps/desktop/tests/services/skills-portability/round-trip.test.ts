import { describe, expect, it } from "vitest";
import { skillToJson } from "@/services/skills-portability/skill-to-json";
import { skillFromJson } from "@/services/skills-portability/skill-from-json";
import { skillToMarkdown } from "@/services/skills-portability/skill-to-markdown";
import { skillFromMarkdown } from "@/services/skills-portability/skill-from-markdown";
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

describe("Markdown + frontmatter round-trip", () => {
  it("skillToMarkdown produces a markdown document with YAML frontmatter", () => {
    const skill = makeSkill();
    const md = skillToMarkdown(skill);
    expect(md).toContain("---");
    expect(md).toContain("slug: my-skill");
    expect(md).toContain("name: My Skill");
    expect(md).toContain("editingOptions: append-section");
    expect(md).toContain("You are a helpful assistant");
  });

  it("round-trips through markdown serialization", () => {
    const skill = makeSkill();
    const md = skillToMarkdown(skill);
    const imported = skillFromMarkdown(md);
    expect(imported.slug).toBe(skill.slug);
    expect(imported.name).toBe(skill.name);
    expect(imported.body.trim()).toBe(skill.body.trim());
    expect(imported.config.editingOptions).toBe(skill.config.editingOptions);
    expect(imported.config.surface).toEqual(skill.config.surface);
  });

  it("round-trips a skill with description", () => {
    const skill = makeSkill({ description: "My description" });
    const md = skillToMarkdown(skill);
    const imported = skillFromMarkdown(md);
    expect(imported.description).toBe("My description");
  });

  it("parses a hand-authored markdown file with YAML frontmatter", () => {
    const handAuthored = `---
slug: summarize
name: Summarize
editingOptions: replace-doc
surface:
  - dock
  - inline
---

Summarize the given note in 3 bullet points.
`;
    const imported = skillFromMarkdown(handAuthored);
    expect(imported.slug).toBe("summarize");
    expect(imported.name).toBe("Summarize");
    expect(imported.config.editingOptions).toBe("replace-doc");
    expect(imported.config.surface).toEqual(["dock", "inline"]);
    expect(imported.body).toContain("Summarize the given note");
  });

  it("throws when required frontmatter is missing (no slug)", () => {
    const badMd = `---
name: No Slug Skill
editingOptions: append-section
surface:
  - dock
---

Some body here.
`;
    expect(() => skillFromMarkdown(badMd)).toThrow();
  });

  it("throws when body is empty", () => {
    const badMd = `---
slug: empty-body
name: Empty Body
editingOptions: append-section
surface:
  - dock
---
`;
    expect(() => skillFromMarkdown(badMd)).toThrow();
  });
});

describe("modeAgnosticPrompt round-trip", () => {
  it("preserves modeAgnosticPrompt through JSON round-trip", () => {
    const skill = makeSkill({
      config: {
        editingOptions: "append-section",
        surface: ["dock"],
        modeAgnosticPrompt: true,
      },
    });
    const imported = skillFromJson(JSON.parse(JSON.stringify(skillToJson(skill))));
    expect(imported.config.modeAgnosticPrompt).toBe(true);
  });

  it("preserves modeAgnosticPrompt through markdown round-trip", () => {
    const skill = makeSkill({
      config: {
        editingOptions: "append-section",
        surface: ["dock"],
        modeAgnosticPrompt: true,
      },
    });
    const md = skillToMarkdown(skill);
    expect(md).toContain("modeAgnosticPrompt: true");
    const imported = skillFromMarkdown(md);
    expect(imported.config.modeAgnosticPrompt).toBe(true);
  });

  it("omits modeAgnosticPrompt from markdown frontmatter when unset (keep YAML minimal)", () => {
    const skill = makeSkill(); // no modeAgnosticPrompt
    const md = skillToMarkdown(skill);
    expect(md).not.toContain("modeAgnosticPrompt");
  });

  it("imports modeAgnosticPrompt as undefined when frontmatter omits it", () => {
    const md = `---
slug: tuned
name: Tuned
editingOptions: append-section
surface:
  - dock
---

A normal mode-tuned skill body.
`;
    const imported = skillFromMarkdown(md);
    expect(imported.config.modeAgnosticPrompt).toBeUndefined();
  });
});
