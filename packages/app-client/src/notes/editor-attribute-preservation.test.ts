import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { yXmlFragmentToProseMirrorRootNode, updateYFragment } from "@tiptap/y-tiptap";
import { getEditorSchema } from "@prismical/editor-schema";
import { YJS_FIELD } from "@prismical/note-derive";

/**
 * Two halves of one contract, both enforced by the Yjs binding's attribute loop:
 *
 *   for (const key in yDomAttrs) { if (pAttrs[key] === undefined) removeAttribute(key) }
 *
 * An attribute this schema does not declare is REMOVED from the stored document on the next edit —
 * so anything the other client writes has to be declared here, or it is lost. And the mirror of
 * that: an attribute declared with a non-null DEFAULT is present on every parsed node, so it gets
 * written into documents that never carried it. `tight` with `default: true` rewrote every list in
 * every note on the first edit. Declaring it `null` keeps the value when it is there and invents
 * nothing when it is not.
 */
const schema = getEditorSchema();

/** Read the fragment with this schema and write it straight back — an ordinary edit. */
function roundTrip(build: (fragment: Y.XmlFragment) => void): { before: string; after: string } {
  const doc = new Y.Doc();
  build(doc.getXmlFragment(YJS_FIELD));
  const before = doc.getXmlFragment(YJS_FIELD).toString();
  const node = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(YJS_FIELD), schema);
  doc.transact(() => {
    updateYFragment(doc, doc.getXmlFragment(YJS_FIELD), node, {
      mapping: new Map(),
      isOMark: new Map(),
    });
  });
  const after = doc.getXmlFragment(YJS_FIELD).toString();
  doc.destroy();
  return { before, after };
}

function bulletList(attrs: Record<string, string>) {
  return (fragment: Y.XmlFragment) => {
    const list = new Y.XmlElement("bulletList");
    for (const [key, value] of Object.entries(attrs)) list.setAttribute(key, value);
    const item = new Y.XmlElement("listItem");
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    text.insert(0, "one");
    paragraph.insert(0, [text]);
    item.insert(0, [paragraph]);
    list.insert(0, [item]);
    fragment.insert(0, [list]);
  };
}

describe("an edit here preserves what the other client wrote", () => {
  it("keeps a list's tight flag", () => {
    expect(roundTrip(bulletList({ tight: "true" })).after).toContain('tight="true"');
    expect(roundTrip(bulletList({ tight: "false" })).after).toContain('tight="false"');
  });

  it("keeps an image's dimensions", () => {
    const { after } = roundTrip((fragment) => {
      const image = new Y.XmlElement("image");
      image.setAttribute("src", "https://example.com/a.png");
      image.setAttribute("width", "640");
      image.setAttribute("height", "480");
      fragment.insert(0, [image]);
    });
    expect(after).toContain("640");
    expect(after).toContain("480");
  });

  it("keeps a textStyle run", () => {
    const { after } = roundTrip((fragment) => {
      const paragraph = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "coloured", { textStyle: { color: "rgb(1, 2, 3)" } });
      paragraph.insert(0, [text]);
      fragment.insert(0, [paragraph]);
    });
    expect(after).toContain("textStyle");
  });
});

describe("an edit here invents nothing", () => {
  it("does not add tight to a list that never had it", () => {
    // With `default: true` this wrote `tight="true"` into every list in every note on first edit.
    const { before, after } = roundTrip(bulletList({}));
    expect(after).not.toContain("tight");
    expect(after).toBe(before);
  });

  it("leaves an ordinary document byte-identical", () => {
    const { before, after } = roundTrip((fragment) => {
      const paragraph = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "plain ");
      text.insert(6, "bold", { bold: {} });
      paragraph.insert(0, [text]);
      fragment.insert(0, [paragraph]);
    });
    expect(after).toBe(before);
  });
});
