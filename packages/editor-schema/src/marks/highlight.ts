import { Mark } from '@tiptap/core';

/**
 * Schema-only `highlight` mark — Tiptap's marker-pen mark (a `<mark>`, optionally coloured).
 *
 * Same contract, and same reason, as the `textStyle` mark next to it: bodies in the wild carry it,
 * and a schema that does not know it deletes the text it covers (see marks/text-style.ts for the
 * mechanism). Nothing here authors it; no commands, no parse rule, and no rendering — highlight is
 * decoration, and this editor does not offer it, so the text displays like its neighbours.
 *
 * `color` is declared only so its value survives a parse/serialize round-trip; ProseMirror drops
 * attributes a mark does not declare.
 */
export const HighlightMark = Mark.create({
  name: 'highlight',
  // Invisible here, so typing at its edge must not silently extend it — see the textStyle mark.
  inclusive: false,

  addAttributes() {
    return { color: { default: null } };
  },

  renderHTML() {
    // Deliberately ignores HTMLAttributes — the mark is readable, not visible.
    return ['span', 0];
  },
});
