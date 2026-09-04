import { describe, it, expect } from "vitest";
import { EditorState } from "@tiptap/pm/state";
import type { JSONContent } from "@tiptap/core";
import { getEditorSchema } from "@prismical/editor-schema";
import { buildCandidateTransaction, buildDiffDecorations } from "./build-decorations";
import { useSkillDiffStore, type SkillDiffCandidate } from "./skill-diff-store";

const schema = getEditorSchema();

function stateWith(children: JSONContent[]): EditorState {
  return EditorState.create({
    schema,
    doc: schema.nodeFromJSON({ type: "doc", content: children }),
  });
}

function candidate(over: Partial<SkillDiffCandidate>): SkillDiffCandidate {
  return {
    noteId: "nt_1",
    skillId: "skl_enhance",
    skillName: "Enhance",
    mode: "append-section",
    modelId: "gpt-5.4-mini",
    reasoning: null,
    refineInstruction: null,
    selectionText: null,
    content: [],
    rawMarkdown: "",
    ...over,
  };
}

describe("buildCandidateTransaction + buildDiffDecorations", () => {
  it("replace-doc yields a non-empty diff (delete old + insert new)", () => {
    const state = stateWith([{ type: "paragraph", content: [{ type: "text", text: "hello world" }] }]);
    const tr = buildCandidateTransaction(
      state,
      candidate({
        mode: "replace-doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "goodbye world" }] }],
        rawMarkdown: "goodbye world",
      }),
    );
    expect(tr).not.toBeNull();
    const decos = buildDiffDecorations(state.doc, tr!, schema);
    expect(decos.find().length).toBeGreaterThan(0);
  });

  it("append-section yields an insert widget without touching the original doc", () => {
    const state = stateWith([{ type: "paragraph", content: [{ type: "text", text: "existing" }] }]);
    const before = state.doc.toString();
    const tr = buildCandidateTransaction(
      state,
      candidate({
        mode: "append-section",
        content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "New" }] }],
        rawMarkdown: "## New",
      }),
    );
    expect(tr).not.toBeNull();
    const decos = buildDiffDecorations(state.doc, tr!, schema);
    expect(decos.find().length).toBeGreaterThan(0);
    // The live doc is never mutated — decorations are an overlay only.
    expect(state.doc.toString()).toBe(before);
  });

  describe("inline-rewrite", () => {
    const inlineCandidate = (over: Partial<SkillDiffCandidate> = {}) =>
      candidate({
        mode: "inline-rewrite",
        selectionText: "hello",
        content: [{ type: "text", text: "hi there" }],
        rawMarkdown: "hi there",
        ...over,
      });

    it("replaces the resolved range with an artifact-inline wrapper (diff shows both sides)", () => {
      // doc: <p>hello world</p> — "hello" spans [1,6).
      const state = stateWith([
        { type: "paragraph", content: [{ type: "text", text: "hello world" }] },
      ]);
      const before = state.doc.toString();
      const tr = buildCandidateTransaction(state, inlineCandidate(), { from: 1, to: 6 });
      expect(tr).not.toBeNull();
      expect(tr!.doc.toString()).toContain("artifact-inline");
      const decos = buildDiffDecorations(state.doc, tr!, schema);
      expect(decos.find().length).toBeGreaterThan(0);
      expect(state.doc.toString()).toBe(before); // overlay only
    });

    it("returns null without a resolved range (anchors unresolvable / target deleted)", () => {
      const state = stateWith([{ type: "paragraph", content: [{ type: "text", text: "x" }] }]);
      expect(buildCandidateTransaction(state, inlineCandidate(), null)).toBeNull();
      expect(buildCandidateTransaction(state, inlineCandidate(), undefined)).toBeNull();
      // Collapsed range = the target text is gone.
      expect(buildCandidateTransaction(state, inlineCandidate(), { from: 1, to: 1 })).toBeNull();
    });

    it("returns null when the range spans two textblocks (wrapper is inline-only)", () => {
      const state = stateWith([
        { type: "paragraph", content: [{ type: "text", text: "one" }] },
        { type: "paragraph", content: [{ type: "text", text: "two" }] },
      ]);
      // From inside <p>one</p> into <p>two</p>.
      expect(buildCandidateTransaction(state, inlineCandidate(), { from: 2, to: 8 })).toBeNull();
    });

    it("returns null when the range is out of bounds (stale beyond doc end)", () => {
      const state = stateWith([{ type: "paragraph", content: [{ type: "text", text: "ab" }] }]);
      expect(
        buildCandidateTransaction(state, inlineCandidate(), { from: 1, to: 999 }),
      ).toBeNull();
    });
  });
});

describe("useSkillDiffStore", () => {
  it("stages and clears a candidate", () => {
    const store = useSkillDiffStore.getState();
    store.stage(candidate({ noteId: "nt_2", mode: "append-section" }));
    expect(useSkillDiffStore.getState().getCandidate("nt_2")?.mode).toBe("append-section");

    // NOTE: no switchMode — flipping append↔replace on a staged candidate without re-running was a
    // data-loss footgun and was removed. Mode changes require a re-run.
    store.clear("nt_2");
    expect(useSkillDiffStore.getState().getCandidate("nt_2")).toBeUndefined();
  });
});
