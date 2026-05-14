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

const artifactDoc = (paragraphs: Array<{ type: string; content?: unknown[] }>) => ({
  type: "doc",
  content: [
    {
      type: "artifact",
      attrs: {
        artifactId: "a1",
        skillId: "s",
        skillName: "S",
        version: 1,
        generatedAt: "2026-05-13T00:00:00Z",
        modelId: "m",
      },
      content: paragraphs,
    },
  ],
});

const paragraph = (text?: string) => ({
  type: "paragraph",
  ...(text ? { content: [{ type: "text", text }] } : {}),
});

function dispatchKey(editor: Editor, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true });
  editor.view.dom.dispatchEvent(event);
}

describe("editor/artifact-escape-plugin — trailing paragraph invariant", () => {
  let editor: Editor;

  beforeEach(() => {
    editor = makeEditor();
  });

  afterEach(() => {
    editor.destroy();
  });

  it("appends a trailing paragraph after an artifact at the end of the doc", () => {
    editor.commands.setContent(artifactDoc([paragraph("Body")]));

    const doc = editor.state.doc;
    expect(doc.childCount).toBe(2);
    expect(doc.firstChild?.type.name).toBe("artifact");
    const last = doc.lastChild;
    expect(last?.type.name).toBe("paragraph");
    expect(last?.textContent).toBe("");
  });

  it("appends a trailing paragraph when an artifact-terminated state is loaded", () => {
    // setContent triggers the appendTransaction, mirroring a fresh load from
    // persistence.
    editor.commands.setContent(artifactDoc([paragraph("hi")]));
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
  });
});

describe("editor/artifact-escape-plugin — escape downward", () => {
  let editor: Editor;

  beforeEach(() => {
    editor = makeEditor();
  });

  afterEach(() => {
    editor.destroy();
  });

  it("Enter on an empty paragraph at the end of an artifact escapes to the trailing paragraph", () => {
    editor.commands.setContent(artifactDoc([paragraph("body"), paragraph()]));
    // Caret in the empty last paragraph of the artifact.
    // Doc: <artifact><p>body</p><p></p></artifact><p></p>
    // Positions: 0 [<artifact>] 1 [<p>] 2..6 [body] 6 [</p>] 7 [<p>] 8 [</p>] 9 [</artifact>] 10 [<p>] 11
    // The empty paragraph inside the artifact starts at position 7.
    const { tr } = editor.state;
    editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 8)));

    dispatchKey(editor, "Enter");

    // After escape: selection should be in the doc's trailing paragraph
    // (the one outside the artifact).
    const { $from } = editor.state.selection;
    let inArtifact = false;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === "artifact") {
        inArtifact = true;
        break;
      }
    }
    expect(inArtifact).toBe(false);
  });

  it("Enter at the end of a non-empty paragraph inside an artifact does NOT escape", () => {
    editor.commands.setContent(artifactDoc([paragraph("body")]));
    // Doc: <artifact><p>body</p></artifact><p></p>
    // Inside the paragraph "body" at end → pos 5.
    const { tr } = editor.state;
    editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 5)));

    dispatchKey(editor, "Enter");

    // Selection should still be inside the artifact (Enter splits the
    // paragraph normally rather than escaping). The default Enter behavior
    // creates a new paragraph at the cursor — so the doc grows, but the
    // selection ancestor chain still includes the artifact.
    const { $from } = editor.state.selection;
    let inArtifact = false;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === "artifact") {
        inArtifact = true;
        break;
      }
    }
    expect(inArtifact).toBe(true);
  });

  it("ArrowDown at the end of an artifact's last paragraph escapes to the trailing paragraph", () => {
    editor.commands.setContent(artifactDoc([paragraph("end")]));
    // Doc: <artifact><p>end</p></artifact><p></p>
    // End of "end" inside the artifact's paragraph → position 5.
    const { tr } = editor.state;
    editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 5)));

    dispatchKey(editor, "ArrowDown");

    const { $from } = editor.state.selection;
    let inArtifact = false;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === "artifact") {
        inArtifact = true;
        break;
      }
    }
    expect(inArtifact).toBe(false);
  });
});

describe("editor/artifact-escape-plugin — escape upward", () => {
  let editor: Editor;

  beforeEach(() => {
    editor = makeEditor();
  });

  afterEach(() => {
    editor.destroy();
  });

  it("ArrowUp at the start of an artifact's first paragraph escapes upward, creating a preceding paragraph if needed", () => {
    editor.commands.setContent(artifactDoc([paragraph("first")]));
    // Doc seeded: <artifact><p>first</p></artifact><p></p>
    // Start of "first" → position 2 (inside the first paragraph).
    const { tr } = editor.state;
    editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 2)));

    dispatchKey(editor, "ArrowUp");

    const doc = editor.state.doc;
    // A new paragraph should now precede the artifact: [p, artifact, p].
    expect(doc.childCount).toBe(3);
    expect(doc.firstChild?.type.name).toBe("paragraph");
    expect(doc.child(1).type.name).toBe("artifact");
    expect(doc.lastChild?.type.name).toBe("paragraph");

    const { $from } = editor.state.selection;
    let inArtifact = false;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === "artifact") {
        inArtifact = true;
        break;
      }
    }
    expect(inArtifact).toBe(false);
  });

  it("Backspace at the start of an artifact's first paragraph escapes upward without deleting the artifact content", () => {
    // Seed: <p>above</p><artifact><p>artifact body</p></artifact>
    editor.commands.setContent({
      type: "doc",
      content: [
        paragraph("above"),
        {
          type: "artifact",
          attrs: {
            artifactId: "a1",
            skillId: "s",
            skillName: "S",
            version: 1,
            generatedAt: "2026-05-13T00:00:00Z",
            modelId: "m",
          },
          content: [paragraph("artifact body")],
        },
      ],
    });

    // Position at start of "artifact body" inside the artifact. Skip past
    // the "above" paragraph (7 chars + open/close = 9) + artifact-open (1) +
    // paragraph-open (1) = position 9.
    const { tr } = editor.state;
    editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 9)));

    dispatchKey(editor, "Backspace");

    // The artifact's content must be intact.
    const doc = editor.state.doc;
    let artifactText = "";
    doc.forEach((child) => {
      if (child.type.name === "artifact") artifactText = child.textContent;
    });
    expect(artifactText).toBe("artifact body");

    // Selection should be in the "above" paragraph, OUTSIDE the artifact.
    const { $from } = editor.state.selection;
    let inArtifact = false;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === "artifact") {
        inArtifact = true;
        break;
      }
    }
    expect(inArtifact).toBe(false);
  });
});
