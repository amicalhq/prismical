import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import { getEditorSchema } from '@prismical/editor-schema';
import { deriveNoteContentFromState, YJS_FIELD } from './index.js';

// A serializer-only failure, no mocks: nodeFromJSON accepts this doc (ProseMirror does not
// validate attribute values), but the markdown heading serializer's `'#'.repeat(level)` throws on
// the negative level. Derivation must keep returning plain text while the Markdown snapshot
// degrades to null.
function stateWithFailingMarkdown(): Uint8Array {
  const ydoc = prosemirrorJSONToYDoc(
    getEditorSchema(),
    {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: -1 }, content: [{ type: 'text', text: 'hello world' }] },
      ],
    },
    YJS_FIELD
  );
  return Y.encodeStateAsUpdate(ydoc);
}

describe('deriveNoteContent — markdown serialization failure is isolated', () => {
  it('still returns plaintext, degrades markdown to null, and reports via onMarkdownError', () => {
    const onMarkdownError = vi.fn();

    const { text, markdown } = deriveNoteContentFromState(stateWithFailingMarkdown(), {
      onMarkdownError,
    });

    expect(text).toContain('hello world');
    expect(markdown).toBeNull();
    expect(onMarkdownError).toHaveBeenCalledTimes(1);
    expect(onMarkdownError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('does not throw when no onMarkdownError callback is given', () => {
    expect(() => deriveNoteContentFromState(stateWithFailingMarkdown())).not.toThrow();
  });
});
