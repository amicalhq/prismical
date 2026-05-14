import { describe, expect, it } from "vitest";
import type { Skill } from "@db/schema";
import type { SkillRunContext } from "@/services/skills-runtime/skill-context";
import type { SkillInput } from "@/services/skills-runtime/collect-input";
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

function makeInput(overrides: Partial<SkillInput> = {}): SkillInput {
  return {
    noteMarkdown: "Existing note body.",
    notePlainText: "Existing note body.",
    transcript: null,
    selectionText: null,
    ...overrides,
  };
}

describe("skills-runtime/build-system-prompt", () => {
  it("contains the skill body in the prompt", () => {
    const prompt = buildSystemPrompt(makeCtx(), makeInput());
    expect(prompt).toContain("You are an AI assistant that enhances notes.");
  });

  it("contains the active mode line", () => {
    const prompt = buildSystemPrompt(
      makeCtx({ mode: "replace-doc" }),
      makeInput(),
    );
    expect(prompt).toContain("# Active mode: replace-doc");
  });

  it("injects the note markdown when present", () => {
    const prompt = buildSystemPrompt(
      makeCtx(),
      makeInput({ noteMarkdown: "## My note\n\nSome content." }),
    );
    expect(prompt).toContain("# Note (markdown)");
    expect(prompt).toContain("## My note");
  });

  it("renders an empty-note marker when there is no body", () => {
    const prompt = buildSystemPrompt(
      makeCtx(),
      makeInput({ noteMarkdown: "" }),
    );
    expect(prompt).toContain("(empty — no content yet)");
  });

  it("injects the transcript when the skill opts in via inputs.transcript", () => {
    const skill = makeSkill("body");
    skill.config = { ...skill.config, inputs: { transcript: true } };
    const prompt = buildSystemPrompt(
      makeCtx({ skill }),
      makeInput({ transcript: "alice: hi\nbob: hello" }),
    );
    expect(prompt).toContain("# Meeting transcript");
    expect(prompt).toContain("alice: hi");
  });

  it("omits the transcript even when one is available if the skill hasn't opted in (default off)", () => {
    // Input policy: transcript injection is opt-in per skill. The model can't
    // ignore data once it's in-context, so "don't use it" prompts aren't
    // sufficient — the runtime must withhold the block.
    const prompt = buildSystemPrompt(
      makeCtx(), // no inputs.transcript
      makeInput({ transcript: "alice: hi\nbob: hello" }),
    );
    expect(prompt).not.toContain("# Meeting transcript");
    expect(prompt).not.toContain("alice: hi");
  });

  it("omits the transcript block when none is linked", () => {
    const skill = makeSkill("body");
    skill.config = { ...skill.config, inputs: { transcript: true } };
    const prompt = buildSystemPrompt(
      makeCtx({ skill }),
      makeInput({ transcript: null }),
    );
    expect(prompt).not.toContain("# Meeting transcript");
  });

  it("contains refine instruction and previous output when both are present", () => {
    const ctx = makeCtx({
      refineInstruction: "Make it shorter",
      previousOutput: "## Old section\n\nSome content here.",
    });
    const prompt = buildSystemPrompt(ctx, makeInput());
    expect(prompt).toContain("# Refine context");
    expect(prompt).toContain("Make it shorter");
    expect(prompt).toContain("## Old section\n\nSome content here.");
    expect(prompt).toContain("Your previous output was:");
  });

  it("does NOT include refine context when refineInstruction is missing", () => {
    const ctx = makeCtx({ previousOutput: "some old output" });
    const prompt = buildSystemPrompt(ctx, makeInput());
    expect(prompt).not.toContain("# Refine context");
  });

  it("does NOT include refine context when previousOutput is missing", () => {
    const ctx = makeCtx({ refineInstruction: "Make it better" });
    const prompt = buildSystemPrompt(ctx, makeInput());
    expect(prompt).not.toContain("# Refine context");
  });

  it("contains selection text for inline-rewrite mode", () => {
    const ctx = makeCtx({ mode: "inline-rewrite" });
    const prompt = buildSystemPrompt(
      ctx,
      makeInput({ selectionText: "the user selected this text" }),
    );
    expect(prompt).toContain("# Active mode: inline-rewrite");
    expect(prompt).toContain("# Selected text to rewrite");
    expect(prompt).toContain("the user selected this text");
  });

  it("does NOT include selection text block for non-inline modes even if selectionText is set", () => {
    const ctx = makeCtx({ mode: "append-section" });
    const prompt = buildSystemPrompt(
      ctx,
      makeInput({ selectionText: "should not appear" }),
    );
    expect(prompt).not.toContain("# Selected text to rewrite");
  });

  describe("modeAgnosticPrompt", () => {
    function makeAgnosticSkill(mode: "append-section" | "replace-doc"): Skill {
      const skill = makeSkill("Agnostic body.");
      skill.config = {
        ...skill.config,
        editingOptions: mode,
        modeAgnosticPrompt: true,
      };
      return skill;
    }

    it("skips the # Active mode block when modeAgnosticPrompt is true (append)", () => {
      const ctx = makeCtx({
        skill: makeAgnosticSkill("append-section"),
        mode: "append-section",
      });
      const prompt = buildSystemPrompt(ctx, makeInput());
      expect(prompt).not.toContain("# Active mode");
      expect(prompt).not.toContain("Produce a new section");
    });

    it("skips the # Active mode block when modeAgnosticPrompt is true (replace)", () => {
      const ctx = makeCtx({
        skill: makeAgnosticSkill("replace-doc"),
        mode: "replace-doc",
      });
      const prompt = buildSystemPrompt(ctx, makeInput());
      expect(prompt).not.toContain("# Active mode");
      expect(prompt).not.toContain("Produce a complete replacement");
    });

    it("rewrites the # Output block to drop mode enumeration when modeAgnosticPrompt is true", () => {
      const ctx = makeCtx({
        skill: makeAgnosticSkill("append-section"),
        mode: "append-section",
      });
      const prompt = buildSystemPrompt(ctx, makeInput());
      expect(prompt).toContain("# Output");
      expect(prompt).toContain("inserted into the note as-is.");
      expect(prompt).not.toContain("append-section appends");
      expect(prompt).not.toContain("replace-doc replaces");
      expect(prompt).not.toContain("inline-rewrite replaces");
    });

    it("STILL injects # Active mode for inline-rewrite even when modeAgnosticPrompt is true (inline exemption)", () => {
      // inline-rewrite needs the explicit guidance because the runner enforces
      // single-paragraph output via markdownToInlineChildren. The agnostic flag
      // is about append <-> replace positioning, never inline.
      const skill = makeAgnosticSkill("append-section");
      skill.config.surface = ["dock", "inline"];
      const ctx = makeCtx({ skill, mode: "inline-rewrite" });
      const prompt = buildSystemPrompt(
        ctx,
        makeInput({ selectionText: "highlighted text" }),
      );
      expect(prompt).toContain("# Active mode: inline-rewrite");
      expect(prompt).toContain("rewrite of the selected text only");
      expect(prompt).toContain("# Selected text to rewrite");
    });

    it("preserves the current mode-tuned behavior when modeAgnosticPrompt is false/undefined", () => {
      // Sanity: existing skills without the flag must produce identical output.
      const prompt = buildSystemPrompt(
        makeCtx({ mode: "replace-doc" }),
        makeInput(),
      );
      expect(prompt).toContain("# Active mode: replace-doc");
      expect(prompt).toContain("Produce a complete replacement");
      expect(prompt).toContain("append-section appends");
    });
  });
});
