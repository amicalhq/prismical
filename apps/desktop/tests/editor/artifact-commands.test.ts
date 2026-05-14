// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { buildEditorExtensions } from "@/services/notes/editor-extensions";

function makeEditor() {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: buildEditorExtensions(),
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
}

const paragraphContent = (text: string) => [
  { type: "paragraph", content: [{ type: "text", text }] },
];

describe("editor commands — insertArtifactBlock", () => {
  let editor: Editor;

  beforeEach(() => {
    editor = makeEditor();
  });

  afterEach(() => {
    editor.destroy();
  });

  it("inserts a new artifact block with the supplied content", () => {
    editor.commands.setContent({
      type: "doc",
      content: paragraphContent("user scratch"),
    });

    editor.commands.insertArtifactBlock({
      artifactId: "a1",
      skillId: "enhance",
      skillName: "Enhance",
      version: 1,
      generatedAt: "2026-05-11T12:00:00Z",
      modelId: "claude-opus-4-7",
      content: paragraphContent("Generated summary"),
    });

    const doc = editor.state.doc;
    // The trailing-paragraph appendTransaction may add an extra empty
    // paragraph after the artifact; assert on what we care about: the user
    // paragraph + the artifact, in order, with the right text.
    expect(doc.firstChild?.type.name).toBe("paragraph");
    expect(doc.firstChild?.textContent).toBe("user scratch");

    let artifactCount = 0;
    let artifactText = "";
    doc.forEach((child) => {
      if (child.type.name === "artifact") {
        artifactCount += 1;
        artifactText = child.textContent;
      }
    });
    expect(artifactCount).toBe(1);
    expect(artifactText).toBe("Generated summary");
  });

  it("replaces the existing artifact block in-place when one matches the skillId (regen invariant)", () => {
    editor.commands.insertArtifactBlock({
      artifactId: "first",
      skillId: "enhance",
      skillName: "Enhance",
      version: 1,
      generatedAt: "2026-05-01T00:00:00.000Z",
      modelId: "model-A",
      content: paragraphContent("First gen"),
    });

    editor.commands.insertArtifactBlock({
      artifactId: "second",
      skillId: "enhance",
      skillName: "Enhance",
      version: 2,
      generatedAt: "2026-05-02T00:00:00.000Z",
      modelId: "model-B",
      content: paragraphContent("Regenerated"),
    });

    let artifactCount = 0;
    let attrs: Record<string, unknown> | null = null;
    let text = "";
    editor.state.doc.forEach((child) => {
      if (child.type.name === "artifact") {
        artifactCount += 1;
        attrs = child.attrs;
        text = child.textContent;
      }
    });

    expect(artifactCount).toBe(1);
    expect(attrs).toMatchObject({
      artifactId: "second",
      version: 2,
      modelId: "model-B",
      generatedAt: "2026-05-02T00:00:00.000Z",
    });
    expect(text).toBe("Regenerated");
  });

  it("appends when no matching block exists, even with another skill present", () => {
    editor.commands.insertArtifactBlock({
      artifactId: "a1",
      skillId: "enhance",
      skillName: "Enhance",
      version: 1,
      generatedAt: "2026-05-01T00:00:00.000Z",
      modelId: "m",
      content: paragraphContent("E"),
    });
    editor.commands.insertArtifactBlock({
      artifactId: "a2",
      skillId: "action-items",
      skillName: "Action items",
      version: 1,
      generatedAt: "2026-05-02T00:00:00.000Z",
      modelId: "m",
      content: paragraphContent("A"),
    });

    const skills: string[] = [];
    editor.state.doc.forEach((child) => {
      if (child.type.name === "artifact") {
        skills.push(child.attrs.skillId as string);
      }
    });
    expect(skills.sort()).toEqual(["action-items", "enhance"]);
  });
});

describe("editor commands — insertArtifactInline", () => {
  let editor: Editor;

  beforeEach(() => {
    editor = makeEditor();
  });

  afterEach(() => {
    editor.destroy();
  });

  it("wraps the current selection in an artifact-inline node", () => {
    editor.commands.setContent({
      type: "doc",
      content: paragraphContent("hello world"),
    });

    // Select "world" — paragraph starts at pos 1, text "hello world" occupies
    // positions 1..12 (1 + 11 chars), so "world" is positions 7..12.
    const { tr } = editor.state;
    editor.view.dispatch(
      tr.setSelection(TextSelection.create(tr.doc, 7, 12)),
    );

    editor.commands.insertArtifactInline({
      artifactId: "i1",
      skillId: "translate-selection",
      skillName: "Translate",
      content: [{ type: "text", text: "earth" }],
    });

    const para = editor.state.doc.firstChild;
    expect(para?.textContent).toBe("hello earth");

    let hasInline = false;
    para?.forEach((child) => {
      if (child.type.name === "artifact-inline") hasInline = true;
    });
    expect(hasInline).toBe(true);
  });
});
