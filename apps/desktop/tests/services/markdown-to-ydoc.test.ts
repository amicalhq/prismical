import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { markdownToYDocUpdate, COLLAB_FRAGMENT_NAME } from "@/services/notes/markdown-to-ydoc";

describe("markdownToYDocUpdate", () => {
  it("encodes markdown into a Yjs update that decodes to an equivalent doc", () => {
    const md = "# Hello\n\nWorld.\n";

    const encoded = markdownToYDocUpdate(md);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);

    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, encoded);
    const fragment = ydoc.getXmlFragment(COLLAB_FRAGMENT_NAME);

    // The fragment should contain one heading + one paragraph
    expect(fragment.length).toBeGreaterThanOrEqual(2);
  });

  it("empty markdown produces a valid update that loads without error", () => {
    const encoded = markdownToYDocUpdate("");
    expect(encoded).toBeInstanceOf(Uint8Array);
    const ydoc = new Y.Doc();
    expect(() => Y.applyUpdate(ydoc, encoded)).not.toThrow();
    const fragment = ydoc.getXmlFragment(COLLAB_FRAGMENT_NAME);
    expect(fragment).toBeDefined();
  });

  it("fragment name constant matches the design (default)", () => {
    expect(COLLAB_FRAGMENT_NAME).toBe("default");
  });
});
