import { Node, mergeAttributes } from '@tiptap/core';

/** Marks the placeholder this node renders, and the ONLY thing its parse rule matches. */
const IMAGE_MARKER = 'data-prismical-image';

/**
 * Each attribute travels as `data-<name>` on the placeholder so a clipboard round-trip keeps it.
 *
 * `numeric` is ONLY for the dimensions. Everything read back out of the DOM is a string, and
 * coercing them all turns an `alt` of "2024" into the NUMBER 2024 — which the markdown serializer
 * then hands to `state.esc()`, throwing `str.replace is not a function` and nulling the whole
 * note's markdown snapshot. Text attributes stay text.
 */
function dataAttribute(name: string, numeric = false) {
  return {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const raw = element.getAttribute(`data-${name}`);
      if (raw === null || raw === '') return null;
      if (!numeric) return raw;
      const asNumber = Number(raw);
      return Number.isFinite(asNumber) ? asNumber : raw;
    },
    renderHTML: (attrs: Record<string, unknown>) =>
      attrs[name] === null || attrs[name] === undefined
        ? {}
        : { [`data-${name}`]: String(attrs[name]) },
  };
}

/**
 * Schema-only `image` node, matching Tiptap's `@tiptap/extension-image` defaults
 * (`inline: false` -> block group, atom; `src` / `alt` / `title` / `width` / `height`).
 *
 * Registered for the same compatibility reason as the marks alongside it: a body carrying a node
 * the schema does not know makes the server derive throw and makes the editor's Yjs binding delete
 * content outright. Nothing here inserts one — there are no commands, and the parse rule below
 * matches only this node's own placeholder, so pasted HTML from anywhere else cannot mint an image.
 *
 * No image is DRAWN. This editor does not offer images, and drawing one would make a feature of a
 * node nothing here can author. What it renders instead is an empty placeholder carrying the
 * attributes, which is what makes the node survive the clipboard: ProseMirror always re-parses
 * pasted HTML, so a placeholder with no attributes and no parse rule would mean that cutting and
 * pasting a region containing an image silently deleted it.
 *
 * `src` may be a `data:` URI — the writing client enables base64.
 */
export const ImageNode = Node.create({
  name: 'image',
  group: 'block',
  atom: true,

  addAttributes() {
    // All five `@tiptap/extension-image` declares. `width`/`height` matter as much as `src`:
    // ProseMirror drops undeclared attributes silently, and the Yjs binding then REMOVES them from
    // the stored document on the next edit, so omitting them would erase a resized image's
    // dimensions permanently.
    return {
      src: dataAttribute('src'),
      alt: dataAttribute('alt'),
      title: dataAttribute('title'),
      width: dataAttribute('width', true),
      height: dataAttribute('height', true),
    };
  },

  parseHTML() {
    return [{ tag: `div[${IMAGE_MARKER}]` }];
  },

  renderHTML({ HTMLAttributes }) {
    // An empty div: the attributes ride along as data-* for the clipboard, nothing is displayed.
    return ['div', mergeAttributes(HTMLAttributes, { [IMAGE_MARKER]: '' })];
  },
});
