import { describe, expect, it } from "vitest";
import type { Skill } from "@db/schema";
import type { SkillRunContext } from "@/services/skills-runtime/skill-context";
import { buildSystemPrompt } from "@/services/skills-runtime/build-system-prompt";

function makeSkill(body: string): Skill {
  return {
    id: "skill-test-id",
    slug: "enhance",
    name: "Enhance",
    description: null,
    iconUrl: null,
    body,
    metadata: {},
    config: { editingOptions: "append-section", surface: ["dock"] },
    allowedTools: null,
    createdBy: null,
    orgId: null,
    system: false,
    public: false,
    featured: false,
    enabled: true,
    parentSkillId: null,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeCtx(overrides: Partial<SkillRunContext> = {}): SkillRunContext {
  return {
    skill: makeSkill("You are an AI assistant that enhances notes."),
    noteId: 1,
    mode: "append-section",
    modelInstanceId: "instance-1",
    modelId: "gpt-4o",
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("skills-runtime/build-system-prompt", () => {
  it("contains the skill body in the prompt", () => {
    const ctx = makeCtx();
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("You are an AI assistant that enhances notes.");
  });

  it("contains the active mode line", () => {
    const ctx = makeCtx({ mode: "replace-doc" });
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("# Active mode: replace-doc");
  });

  it("contains refine instruction and previous output when both are present", () => {
    const ctx = makeCtx({
      refineInstruction: "Make it shorter",
      previousOutput: "## Old section\n\nSome content here.",
    });
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("# Refine context");
    expect(prompt).toContain("Make it shorter");
    expect(prompt).toContain("## Old section\n\nSome content here.");
    expect(prompt).toContain("Your previous output was:");
  });

  it("does NOT include refine context when refineInstruction is missing", () => {
    const ctx = makeCtx({ previousOutput: "some old output" });
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain("# Refine context");
  });

  it("does NOT include refine context when previousOutput is missing", () => {
    const ctx = makeCtx({ refineInstruction: "Make it better" });
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain("# Refine context");
  });

  it("contains selection text for inline-rewrite mode", () => {
    const ctx = makeCtx({
      mode: "inline-rewrite",
      selectionText: "the user selected this text",
    });
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("# Active mode: inline-rewrite");
    expect(prompt).toContain("the user selected this text");
    expect(prompt).toContain("The user's selected text to rewrite:");
  });

  it("does NOT include selection text block for non-inline modes even if selectionText is set", () => {
    const ctx = makeCtx({
      mode: "append-section",
      selectionText: "should not appear",
    });
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain("The user's selected text to rewrite:");
  });
});
