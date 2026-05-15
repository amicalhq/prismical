import * as Y from "yjs";
import { prosemirrorJSONToYDoc } from "y-prosemirror";
import { getSchema } from "@tiptap/core";
import { markdownToTiptapJson } from "@/services/notes/tiptap-markdown";
import { buildEditorExtensions } from "@/services/notes/editor-extensions";

// IMPORTANT: this fragment name MUST match the `field` option passed to
// `Collaboration.configure(...)` in editor-shared.tsx (Task 7).
// - y-prosemirror's prosemirrorJSONToYDoc defaults its fragment name to
//   "prosemirror".
// - TipTap's @tiptap/extension-collaboration defaults its `field` to
//   "default".
// We align the two manually; "default" keeps TipTap's defaults clean.
// If this value changes, change Collaboration's `field` to match in lockstep.
export const COLLAB_FRAGMENT_NAME = "default";

// One-shot helper: take a markdown string, build a Y.Doc whose
// XmlFragment(COLLAB_FRAGMENT_NAME) mirrors the prosemirror doc decoded
// from the markdown, and return that Y.Doc's full state as an update blob
// suitable for `saveYjsUpdate()`. Used by the seed flow and any future
// markdown-import path.
export function markdownToYDocUpdate(markdown: string): Uint8Array {
  const json = markdownToTiptapJson(markdown);
  // y-prosemirror signature: prosemirrorJSONToYDoc(schema, state, xmlFragmentName?)
  // `state` is typed as `any` in y-prosemirror's lib.d.ts, so the `unknown`
  // return from markdownToTiptapJson is accepted without an unsafe cast.
  const schema = getSchema(buildEditorExtensions());
  const ydoc = prosemirrorJSONToYDoc(schema, json, COLLAB_FRAGMENT_NAME);
  try {
    return Y.encodeStateAsUpdate(ydoc);
  } finally {
    ydoc.destroy();
  }
}
