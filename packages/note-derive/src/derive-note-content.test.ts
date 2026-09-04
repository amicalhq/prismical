import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import { getEditorSchema } from '@prismical/editor-schema';
import {
  deriveNoteContent,
  deriveNoteContentFromState,
  deriveNoteContentFromYDoc,
  YJS_FIELD,
} from './index.js';

// Build a Yjs update from Tiptap/ProseMirror JSON exactly as a client editor would, so we can feed
// real document states into deriveNoteContentFromState (the inverse of what it does internally).
function stateFromJson(pmJson: object): Uint8Array {
  const ydoc = prosemirrorJSONToYDoc(getEditorSchema(), pmJson, YJS_FIELD);
  return Y.encodeStateAsUpdate(ydoc);
}

describe('deriveNoteContent', () => {
  it('derives BOTH stripped plaintext and markdown from one parse', () => {
    const state = stateFromJson({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heading' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] },
      ],
    });

    const { text, markdown, firstLine } = deriveNoteContentFromState(state);

    // The plain-text projection contains no Markdown syntax and is suitable for search.
    expect(text).toContain('Heading');
    expect(text).toContain('hello world');
    expect(text).not.toContain('##');

    // The Markdown projection keeps the structure (## heading).
    expect(markdown).toContain('## Heading');
    expect(markdown).toContain('hello world');

    // first_line is the first document line (drives derived note titles).
    expect(firstLine).toBe('Heading');
  });

  it('returns identical output from all three entry points for the same doc', () => {
    const pmJson = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
    };
    const ydoc = prosemirrorJSONToYDoc(getEditorSchema(), pmJson, YJS_FIELD);

    const fromState = deriveNoteContentFromState(Y.encodeStateAsUpdate(ydoc));
    expect(deriveNoteContentFromYDoc(ydoc)).toEqual(fromState);
    expect(deriveNoteContent(pmJson)).toEqual(fromState);
  });

  it('returns empty text and empty markdown for an empty doc', () => {
    const state = stateFromJson({ type: 'doc', content: [{ type: 'paragraph' }] });
    const { text, markdown } = deriveNoteContentFromState(state);
    // '' means an empty doc; null strictly means serializer failure (tri-state, keep distinct).
    expect(text).toBe('');
    expect(markdown).toBe('');
  });

  it('throws on a node type the shared schema does not know (caller decides policy)', () => {
    // Parse failure = schema drift; it must SURFACE (the note service logs loudly and persists the
    // binary with empty derived fields) — only markdown failure is isolated.
    expect(() =>
      deriveNoteContent({ type: 'doc', content: [{ type: 'martianBlock' }] })
    ).toThrow();
  });
});
