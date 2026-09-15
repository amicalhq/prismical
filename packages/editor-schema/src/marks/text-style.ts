import { Mark } from '@tiptap/core';

/**
 * Schema-only `textStyle` mark — the standard Tiptap inline-style mark (a `<span>` carrying CSS).
 *
 * Registered for COMPATIBILITY, not as an authoring feature. Bodies carrying it exist in the wild,
 * and a schema that does not know the mark handles them destructively:
 *
 *   - server (`y-prosemirror` -> `nodeFromJSON`) throws `RangeError: There is no mark type textStyle
 *     in this schema`, so the note store persists the binary with empty derived text; and
 *   - the editor's Yjs binding (`@tiptap/y-tiptap` `createTextNodesFromYText`) catches that same
 *     error and DELETES the offending `Y.XmlText` from the CRDT — the text is gone for every client.
 *
 * Registering the mark is what stops both.
 *
 * Three deliberate omissions, each load-bearing:
 *
 *   - **no `parseHTML`** — a rule broad enough to match the spans this mark describes would also
 *     mint it from every styled `<span>` in pasted HTML, turning a compatibility shim into an
 *     inline-CSS import. The mark only ever arrives from a stored document.
 *   - **no rendering** — `renderHTML` emits a bare `<span>` and drops every attribute, so the text
 *     displays exactly like its neighbours. This editor does not do inline colour; showing it here
 *     would make a feature of a mark nothing can author, and text coloured for a dark phone theme
 *     would be unreadable (or invisible) against a different background.
 *   - **no `excludes`** — ProseMirror's default (the mark excludes itself) is what keeps the Yjs
 *     attribute key the plain `textStyle`. Setting `excludes: ''` moves it to a hashed
 *     `textStyle--<hash>` key, which is not the shape existing documents are written in.
 */
export const TextStyleMark = Mark.create({
  name: 'textStyle',
  // Typing at the edge of an existing run must NOT extend it. The mark is invisible here, so an
  // inclusive one spreads silently onto new text the author cannot see or clear.
  inclusive: false,

  // `color` ONLY, matching what the writing client declares. A mark's attributes are stored in the
  // CRDT as one object, so every attribute declared here is written into the document on the next
  // edit — declaring the wider Tiptap TextStyle family put `backgroundColor="null"`,
  // `fontFamily="null"`, `fontSize="null"` and `lineHeight="null"` into real notes, which the
  // writing client would then strip again on its next edit. Nothing writes those anyway: only the
  // colour bridge ever set an attribute on this mark.
  addAttributes() {
    return { color: { default: null } };
  },

  renderHTML() {
    // Deliberately ignores HTMLAttributes — see "no rendering" above.
    return ['span', 0];
  },
});
