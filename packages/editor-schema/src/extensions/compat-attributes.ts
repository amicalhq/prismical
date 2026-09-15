import { Extension } from '@tiptap/core';

/**
 * Attributes another client adds to nodes THIS schema already has.
 *
 * A missing node or mark is loud — it throws, and the Yjs binding deletes the content. A missing
 * ATTRIBUTE is silent: ProseMirror's `computeAttrs` drops anything the type does not declare, so
 * the value simply disappears the first time a client here re-serializes that node. The
 * server-side body write rebuilds the WHOLE document through `nodeFromJSON`, so one append strips
 * the attribute from every node in the note at once.
 *
 * Declared here rather than on the node specs themselves because the nodes come from StarterKit,
 * which does not expose its sub-extensions for `.extend()`. A global attribute is also exactly the
 * mechanism the writing client uses to add them.
 *
 * `tight` on the list types comes from `tiptap-markdown`'s MarkdownTightLists, which that client
 * mounts. It records whether the list was written in markdown's tight form; nothing here reads it,
 * it is preserved so a round-trip does not rewrite the author's list spacing.
 *
 * The default is `null`, NOT the writing client's `true`. A non-null default is present on every
 * parsed node, and the same binding loop that removes undeclared attributes then WRITES it into
 * documents that never carried it — `default: true` added `tight="true"` to every list in every
 * note on its first edit. Null keeps the value where it exists and invents nothing where it does
 * not. Pinned by editor-attribute-preservation.test.ts in app-client.
 */
export const CompatAttributes = Extension.create({
  name: 'compatAttributes',

  addGlobalAttributes() {
    return [
      {
        types: ['bulletList', 'orderedList'],
        attributes: { tight: { default: null } },
      },
    ];
  },
});
