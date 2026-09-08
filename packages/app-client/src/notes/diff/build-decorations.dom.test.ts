// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@tiptap/pm/state";
import { EditorView, DecorationSet } from "@tiptap/pm/view";
import { history, undo } from "@tiptap/pm/history";
import type { JSONContent } from "@tiptap/core";
import { getEditorSchema } from "@prismical/editor-schema";
import { buildCandidateTransaction, buildDiffDecorations } from "./build-decorations";
import type { SkillDiffCandidate } from "./skill-diff-store";

const schema = getEditorSchema();
const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (value: string): JSONContent => ({ type: "paragraph", content: [text(value)] });
const heading = (value: string): JSONContent => ({
  type: "heading",
  attrs: { level: 2 },
  content: [text(value)],
});
const list = (...items: string[]): JSONContent => ({
  type: "bulletList",
  content: items.map(value => ({ type: "listItem", content: [paragraph(value)] })),
});
const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach(view => view.destroy());
  document.body.replaceChildren();
});

function preview(
  original: JSONContent[],
  proposed: JSONContent[],
  mode: SkillDiffCandidate["mode"] = "replace-doc"
) {
  const state = EditorState.create({
    schema,
    doc: schema.nodeFromJSON({ type: "doc", content: original }),
    plugins: [history()],
  });
  const candidate: SkillDiffCandidate = {
    noteId: "nt_preview",
    skillId: "skl_cleanup",
    skillName: "Cleanup",
    mode,
    modelId: "test-model",
    reasoning: null,
    refineInstruction: null,
    selectionText: null,
    content: proposed,
    rawMarkdown: "fixture",
  };
  const transaction = buildCandidateTransaction(state, candidate)!;
  expect(transaction).not.toBeNull();
  const sourceJson = state.doc.toJSON(),
    proposedJson = transaction.doc.toJSON();
  let decorations = buildDiffDecorations(state.doc, transaction, schema);
  const mount = document.createElement("div");
  document.body.append(mount);
  const view = new EditorView(mount, {
    state,
    editable: () => false,
    decorations: () => decorations,
  });
  views.push(view);
  expect(view.state.doc.toJSON()).toEqual(sourceJson);
  expect(transaction.doc.toJSON()).toEqual(proposedJson);
  return {
    dom: view.dom,
    sourceJson,
    proposedJson,
    refine(content: JSONContent[]) {
      const refined = buildCandidateTransaction(view.state, { ...candidate, content })!;
      decorations = buildDiffDecorations(view.state.doc, refined, schema);
      view.updateState(view.state);
    },
    keepAndUndo() {
      decorations = DecorationSet.empty;
      view.dispatch(transaction);
      expect(view.state.doc.toJSON()).toEqual(proposedJson);
      expect(undo(view.state, view.dispatch)).toBe(true);
      expect(view.state.doc.toJSON()).toEqual(sourceJson);
    },
  };
}

describe("rendered skill diff", () => {
  it("does not mark an empty note's placeholder paragraph as deleted", () => {
    const result = preview([{ type: "paragraph" }], [heading("Summary"), paragraph("New content")]);
    expect(result.dom.querySelector(".prismical-diff-delete")).toBeNull();
    expect(result.dom.querySelector(".prismical-diff-insert h2")?.textContent).toBe("Summary");
    expect(result.dom.querySelector(".prismical-diff-insert p")?.textContent).toBe("New content");
    result.keepAndUndo();
  });

  it("refreshes same-length refined proposals instead of reusing a stale widget", () => {
    const result = preview([paragraph("xxxxx")], [paragraph("alpha")]);
    expect(result.dom.querySelector(".prismical-diff-insert")?.textContent).toBe("alpha");
    result.refine([paragraph("bravo")]);
    expect(result.dom.querySelector(".prismical-diff-insert")?.textContent).toBe("bravo");
    expect(result.dom.textContent).not.toContain("alpha");
  });

  it.each([
    ["🙂", "🙃"],
    ["cafe", "cafe\u0301"],
  ])("keeps glyph clusters intact: %s to %s", (before, after) => {
    const result = preview([paragraph(before)], [paragraph(after)]);
    expect(result.dom.querySelector(".prismical-diff-insert p")?.textContent).toBe(after);
    result.keepAndUndo();
  });

  it("keeps a paragraph-to-heading rewrite in complete blocks, including the first capital letter", () => {
    const result = preview(
      [paragraph("dispatch memo. the dispatch code is ref-37. mira dalton owns the dispatch.")],
      [
        heading("Dispatch Memo"),
        paragraph("The dispatch code is ref-37. Mira Dalton owns the dispatch."),
      ]
    );
    const inserted = result.dom.querySelectorAll(".prismical-diff-insert");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.querySelector("h2")?.textContent).toBe("Dispatch Memo");
    expect(inserted[0]!.querySelector("p")?.textContent).toBe(
      "The dispatch code is ref-37. Mira Dalton owns the dispatch."
    );
    expect(result.dom.querySelector("p.prismical-diff-delete")?.textContent).toContain(
      "dispatch memo."
    );
    expect(result.dom.querySelector("p div, p span p, p span h2")).toBeNull();
    result.keepAndUndo();
  });

  it("does not create partial or empty bullets when notes become a list", () => {
    const result = preview(
      [paragraph("Backend persistence ref-37"), paragraph("Web persistence ref-37")],
      [heading("References"), list("Backend persistence ref-37", "Web persistence ref-37")]
    );
    const inserted = result.dom.querySelector(".prismical-diff-insert")!;
    expect([...inserted.querySelectorAll("li")].map(item => item.textContent)).toEqual([
      "Backend persistence ref-37",
      "Web persistence ref-37",
    ]);
    expect(result.dom.querySelector("span.prismical-diff-insert ul")).toBeNull();
    result.keepAndUndo();
  });

  it("renders edits to nested lists as intact lists", () => {
    const result = preview(
      [list("Dispatch code ref-37", "Owner Mira")],
      [list("Dispatch code ref-37", "Owner Mira Dalton", "Confirm dispatch")]
    );
    expect(result.dom.querySelector("ul.prismical-diff-delete")).not.toBeNull();
    expect(
      [...result.dom.querySelectorAll(".prismical-diff-insert li")].map(node => node.textContent)
    ).toEqual(["Dispatch code ref-37", "Owner Mira Dalton", "Confirm dispatch"]);
    result.keepAndUndo();
  });

  it("leaves unchanged blocks between edits undecorated", () => {
    const result = preview(
      [paragraph("old one"), paragraph("keep this"), paragraph("old two")],
      [paragraph("new one"), paragraph("keep this"), paragraph("new two")]
    );
    const untouched = [...result.dom.children].find(node => node.textContent === "keep this")!;
    expect(untouched.classList.contains("prismical-diff-delete")).toBe(false);
    expect(untouched.querySelector(".prismical-diff-insert, .prismical-diff-delete")).toBeNull();
    result.keepAndUndo();
  });

  it("keeps simple edits inline and renders inserted text after deleted text", () => {
    const result = preview([heading("hello world")], [heading("goodbye world")]);
    const h2 = result.dom.querySelector("h2")!;
    expect(h2.querySelector("div")).toBeNull();
    expect(h2.querySelector(".prismical-diff-insert")?.tagName).toBe("SPAN");
    expect(h2.querySelector(".prismical-diff-delete")?.nextElementSibling?.className).toContain(
      "prismical-diff-insert"
    );
    result.keepAndUndo();
  });

  it("shows formatting-only changes instead of silently treating them as equal", () => {
    const result = preview(
      [paragraph("Important")],
      [{ type: "paragraph", content: [{ ...text("Important"), marks: [{ type: "bold" }] }] }]
    );
    expect(result.dom.querySelector(".prismical-diff-insert strong")?.textContent).toBe(
      "Important"
    );
    expect(result.dom.querySelector(".prismical-diff-delete")?.textContent).toBe("Important");
    result.keepAndUndo();
  });

  it.each(["bold", "italic", "strike", "code"])("does not inherit removed %s formatting", mark => {
    const result = preview(
      [{ type: "paragraph", content: [{ ...text("Important tail"), marks: [{ type: mark }] }] }],
      [
        {
          type: "paragraph",
          content: [text("Important"), { ...text(" tail"), marks: [{ type: mark }] }],
        },
      ]
    );
    const inserted = result.dom.querySelector(".prismical-diff-insert")!;
    expect(inserted.textContent).toBe("Important");
    expect(inserted.closest("strong, em, s, code")).toBeNull();
    result.keepAndUndo();
  });

  it("preserves duplicate blocks and their positions", () => {
    const result = preview(
      [paragraph("repeat"), paragraph("before"), paragraph("repeat")],
      [paragraph("repeat"), paragraph("after"), paragraph("repeat")]
    );
    expect([...result.dom.children].filter(node => node.textContent === "repeat")).toHaveLength(2);
    result.keepAndUndo();
  });

  it("renders an appended artifact without marking the existing note as deleted", () => {
    const result = preview(
      [paragraph("existing notes")],
      [heading("Recording"), list("First point", "Second point")],
      "append-section"
    );
    expect(result.dom.querySelector(".prismical-diff-delete")).toBeNull();
    expect(result.dom.querySelector(".prismical-diff-insert h2")?.textContent).toBe("Recording");
    result.keepAndUndo();
  });

  it("bounds alignment for large rewrites and preserves every proposed block", () => {
    const result = preview(
      Array.from({ length: 501 }, (_, i) => paragraph(`Original ${i}`)),
      Array.from({ length: 501 }, (_, i) => paragraph(`Proposed ${i}`))
    );
    expect(result.dom.querySelectorAll("div.prismical-diff-insert")).toHaveLength(1);
    expect(result.dom.querySelectorAll(".prismical-diff-insert p")).toHaveLength(501);
    result.keepAndUndo();
  });
});
