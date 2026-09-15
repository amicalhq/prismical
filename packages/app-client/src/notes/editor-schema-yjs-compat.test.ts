import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { getEditorSchema } from "@prismical/editor-schema";
import { YJS_FIELD } from "@prismical/note-derive";

/**
 * The editor's Yjs binding is not merely lossy about marks the schema does not know — it is
 * DESTRUCTIVE. `createTextNodesFromYText` catches the schema error and deletes the offending
 * `Y.XmlText` from the document inside a Yjs transaction, so the text disappears from the CRDT for
 * every client and for the server's stored binary. `textStyle` is the mark that exposed this, and
 * these tests pin the contract that keeps the text alive: whatever the shared schema registers,
 * the web and desktop editors bind without dropping content. `highlight` and `image` come from the
 * same writing client and travel the same path, so they are covered here too.
 *
 * This covers desktop as well as web: both mount the same shared extension set, and
 * editor-extensions.test.ts pins that set's marks to the shared schema's.
 */
function bodyWithTextStyle(): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(YJS_FIELD);

  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  text.insert(0, "before ");
  text.insert(7, "styled", { textStyle: { color: "rgb(1, 2, 3)" } });
  text.insert(13, " after");
  paragraph.insert(0, [text]);

  const second = new Y.XmlElement("paragraph");
  const plain = new Y.XmlText();
  plain.insert(0, "untouched paragraph");
  second.insert(0, [plain]);

  fragment.insert(0, [paragraph, second]);
  return doc;
}

/** The other two shapes the same writing client produces: a highlight mark and an image node. */
function bodyWithHighlightAndImage(): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(YJS_FIELD);

  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  text.insert(0, "keep ");
  text.insert(5, "marked", { highlight: { color: "yellow" } });
  text.insert(11, " too");
  paragraph.insert(0, [text]);

  const image = new Y.XmlElement("image");
  image.setAttribute("src", "https://example.com/a.png");
  image.setAttribute("alt", "a shot");

  fragment.insert(0, [paragraph, image]);
  return doc;
}

describe("editor Yjs binding against a body carrying textStyle", () => {
  it("renders the whole paragraph, styled run included", () => {
    const doc = bodyWithTextStyle();

    const node = yXmlFragmentToProseMirrorRootNode(
      doc.getXmlFragment(YJS_FIELD),
      getEditorSchema(),
    );

    expect(node.textContent).toContain("before styled after");
    expect(node.textContent).toContain("untouched paragraph");
    doc.destroy();
  });

  it("does not delete anything from the CRDT while binding", () => {
    const doc = bodyWithTextStyle();
    const before = Y.encodeStateAsUpdate(doc);

    yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(YJS_FIELD), getEditorSchema());

    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(doc.getXmlFragment(YJS_FIELD).toString()).toContain("styled");
    doc.destroy();
  });
});

describe("editor Yjs binding against highlight and image bodies", () => {
  it("renders the highlighted run and keeps the image node", () => {
    const doc = bodyWithHighlightAndImage();

    const node = yXmlFragmentToProseMirrorRootNode(
      doc.getXmlFragment(YJS_FIELD),
      getEditorSchema(),
    );

    expect(node.textContent).toContain("keep marked too");
    expect(node.lastChild?.type.name).toBe("image");
    expect(node.lastChild?.attrs.src).toBe("https://example.com/a.png");
    doc.destroy();
  });

  it("does not delete anything from the CRDT while binding", () => {
    const doc = bodyWithHighlightAndImage();
    const before = Y.encodeStateAsUpdate(doc);

    yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(YJS_FIELD), getEditorSchema());

    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(doc.getXmlFragment(YJS_FIELD).toString()).toContain("marked");
    doc.destroy();
  });
});
