// Pure note-body derivation shared by persisted-body writers. Derives plain text, Markdown, and
// the first line from a note's Tiptap/Yjs document using the shared editor schema. DOM-free
// (headless schema + prosemirror-markdown), so it runs in Node, Electron main, and the renderer.

import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { getEditorSchema } from '@prismical/editor-schema';
import { tiptapJsonToMarkdown, firstNoteLine } from '@prismical/editor-markdown';

/**
 * Tiptap's Collaboration extension stores the document under this Yjs field — matches
 * `Collaboration.configure({ field: 'default' })` on the client editor
 * (packages/app-client/src/notes/editor-extensions.ts).
 */
export const YJS_FIELD = 'default';

export interface DerivedNoteContent {
  /** Stripped plain text used for search. */
  text: string;
  /** Markdown fidelity snapshot; null when serialization failed. */
  markdown: string | null;
  /** Grapheme-80-clamped first document line — drives derived note titles. */
  firstLine: string;
}

export interface DeriveOptions {
  /** Called instead of throwing when markdown serialization fails (text/firstLine still returned). */
  onMarkdownError?: (err: unknown) => void;
}

// Parse the document with the shared Tiptap schema once and derive both body snapshots:
//   - text: plain text used for search.
//   - markdown: the fidelity snapshot used by body reads.
// Parsing (nodeFromJSON) throws if the doc uses a node type the schema doesn't know (parity
// violation) — failure policy belongs to the CALLER, which surfaces it loudly instead of silently
// storing empty text.
// Markdown serialization is isolated in its own try/catch: a serializer-only failure must not
// blank the plain text, so it degrades to `markdown: null` rather than throwing;
// `onMarkdownError` observes the error.

/**
 * Derive from Tiptap/ProseMirror JSON (e.g. `editor.getJSON()`). THROWS if the JSON uses
 * a node the shared schema doesn't know (parity violation) — callers decide policy.
 */
export function deriveNoteContent(json: unknown, opts?: DeriveOptions): DerivedNoteContent {
  const node = getEditorSchema().nodeFromJSON(json);
  // textBetween inserts a '\n' between block nodes (and ' ' for inline leaves), giving the body
  // as newline-separated lines for the content_text search index.
  const text = node.textBetween(0, node.content.size, '\n', ' ');

  // Serialize the SAME parsed JSON to markdown (avoids a redundant ProseMirror round-trip).
  let markdown: string | null = null;
  try {
    markdown = tiptapJsonToMarkdown(json as object);
  } catch (err) {
    opts?.onMarkdownError?.(err);
  }
  return { text, markdown, firstLine: firstNoteLine(json) };
}

/** Derivation from a live Y.Doc (server direct-connection docs; desktop main after log replay). */
export function deriveNoteContentFromYDoc(doc: Y.Doc, opts?: DeriveOptions): DerivedNoteContent {
  return deriveNoteContent(yDocToProsemirrorJSON(doc, YJS_FIELD), opts);
}

/** Derivation from an encoded Yjs update/state (the note-service store hook's input). */
export function deriveNoteContentFromState(
  state: Uint8Array,
  opts?: DeriveOptions
): DerivedNoteContent {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, state);
  return deriveNoteContentFromYDoc(ydoc, opts);
}
