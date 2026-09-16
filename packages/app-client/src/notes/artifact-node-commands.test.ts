// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { buildWebEditorExtensions } from "./editor-extensions";
import { withEditorHistoryBoundary } from "./editor-history";
import { buildCandidateTransaction, buildDiffDecorations } from "./diff/build-decorations";
import { applyPreparedSkillResult, prepareSkillResultUpdate } from "./diff/skill-result-application";
import type { SkillDiffCandidate } from "./diff/skill-diff-store";

beforeAll(() => { document.elementFromPoint = () => null; });
const resources: Array<{ editor: Editor; doc: Y.Doc }> = [];
afterEach(() => { resources.splice(0).forEach(({ editor, doc }) => { editor.destroy(); doc.destroy(); }); });
function create(update?: Uint8Array) {
  const doc = new Y.Doc();
  if (update) Y.applyUpdate(doc, update);
  const editor = new Editor({ extensions: buildWebEditorExtensions(doc, "", "") });
  resources.push({ editor, doc });
  return { editor, doc };
}
const payload = {
  artifactId: "artifact", skillId: "skill", skillName: "Summary", version: 1,
  generatedAt: "2026-01-01T00:00:00Z", modelId: "model",
  content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Summary" }] }],
};
const candidate: SkillDiffCandidate = { ...payload, noteId: "note", mode: "append-section",
  reasoning: null, refineInstruction: null, selectionText: null, rawMarkdown: "## Summary" };
const types = (editor: Editor) => editor.getJSON().content?.map(node => node.type);

describe("artifact insertion", () => {
  it.each(["legacy", "durable"] as const)("replaces the default paragraph through %s apply, persists and undoes", mode => {
    const { editor, doc } = create();
    const original = editor.getJSON();
    const preview = buildCandidateTransaction(editor.state, candidate)!;
    expect(preview.doc.firstChild?.type.name).toBe("artifact");
    expect(buildDiffDecorations(editor.state.doc, preview, editor.schema).find()[0]?.from).toBe(0);
    expect(editor.getJSON()).toEqual(original);
    const apply = {
      legacy: () => withEditorHistoryBoundary(editor, () => editor.commands.insertArtifactBlock(payload)),
      durable: () => applyPreparedSkillResult(editor, prepareSkillResultUpdate(editor, "result", draft => draft.commands.insertArtifactBlock(payload))),
    };
    apply[mode]();
    expect(types(editor)).toEqual(["artifact", "paragraph"]);
    expect(editor.view.dom.firstElementChild?.tagName).toBe("DIV");
    expect(create(Y.encodeStateAsUpdate(doc)).editor.getJSON()).toEqual(editor.getJSON());
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(original);
    expect(editor.commands.redo()).toBe(true);
    expect(types(editor)).toEqual(["artifact", "paragraph"]);
  });

  it.each(["<p></p><p></p>", "<p> </p>", "<p></p><p>Scratch</p><p></p>", "<h2></h2><p></p>", "<p><br></p>"])("preserves existing structure: %s", html => {
    const { editor } = create();
    editor.commands.setContent(html, { parseOptions: { preserveWhitespace: "full" } });
    const original = editor.getJSON().content!;
    const preview = buildCandidateTransaction(editor.state, candidate)!;
    expect(preview.doc.toJSON().content.slice(0, original.length)).toEqual(original);
    expect(editor.commands.insertArtifactBlock(payload)).toBe(true);
    expect(editor.getJSON().content!.slice(0, original.length)).toEqual(original);
  });

  it("regenerates in place and keeps surrounding blank lines", () => {
    const { editor } = create();
    editor.commands.setContent("<p></p><p>Scratch</p><p></p>");
    editor.commands.insertArtifactBlock(payload);
    const before = editor.getJSON().content!;
    const changed = { ...payload, version: 2, content: [{ type: "paragraph", content: [{ type: "text", text: "Revised" }] }] };
    const preview = buildCandidateTransaction(editor.state, { ...candidate, content: changed.content })!;
    expect(editor.commands.insertArtifactBlock(changed)).toBe(true);
    expect(types(editor)).toEqual(before.map(node => node.type));
    expect(editor.getJSON().content!.slice(0, 3)).toEqual(before.slice(0, 3));
    expect(editor.getJSON().content![3]!.attrs?.version).toBe(2);
    expect(preview.doc.child(3).textContent).toBe("Revised");
    expect(editor.state.doc.child(3).textContent).toBe("Revised");
  });
});

describe("empty artifact cleanup", () => {
  it("removes the marker after deleting the last text, persists, and restores it on undo", () => {
    const { editor, doc } = create();
    withEditorHistoryBoundary(editor, () => editor.commands.insertArtifactBlock(payload));
    const generated = editor.getJSON();
    withEditorHistoryBoundary(editor, () => editor.commands.deleteRange({ from: 2, to: 9 }));
    expect(types(editor)).not.toContain("artifact");
    expect(editor.view.dom.querySelector(".prismical-artifact-node__sparkle")).toBeNull();
    expect(create(Y.encodeStateAsUpdate(doc)).editor.getJSON()).toEqual(editor.getJSON());
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(generated);
    expect(editor.commands.redo()).toBe(true);
    expect(types(editor)).not.toContain("artifact");
    editor.commands.insertContent("My own text");
    expect(types(editor)).not.toContain("artifact");
  });

  it("keeps the marker while generated text remains", () => {
    const { editor } = create();
    editor.commands.insertArtifactBlock(payload);
    editor.commands.deleteRange({ from: 2, to: 8 });
    expect(types(editor)).toContain("artifact");
    expect(editor.state.doc.firstChild?.textContent).toBe("y");
  });

  it.each([
    [{ type: "image", attrs: { src: "https://example.com/image.png" } }],
    [{ type: "horizontalRule" }],
  ])("keeps non-text generated content: %j", (...content) => {
    const { editor } = create();
    editor.commands.insertArtifactBlock({ ...payload, content });
    expect(types(editor)).toContain("artifact");
  });

  it("cleans up an already empty wrapper without removing its blank lines", () => {
    const { editor } = create();
    editor.commands.insertArtifactBlock({ ...payload, content: [{ type: "paragraph" }, { type: "paragraph" }] });
    expect(types(editor)).toEqual(["paragraph", "paragraph"]);
  });
});
