import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { deriveNoteContentFromState, deriveNoteContentFromYDoc, YJS_FIELD } from './index.js';

/**
 * Bodies in the wild carry a `textStyle` mark (inline CSS on a span). Nothing here applies it, so
 * these fixtures write the Yjs attribute BY HAND — exactly the shape a writing client leaves behind
 * — rather than going through a ProseMirror schema. That keeps the test honest: it fails if the
 * shared schema stops registering the mark, instead of quietly agreeing with itself.
 */
function bodyWithTextStyle(): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(YJS_FIELD);

  const heading = new Y.XmlElement('heading');
  heading.setAttribute('level', '2' as unknown as string);
  const headingText = new Y.XmlText();
  headingText.insert(0, 'Quarterly review', { textStyle: { color: 'rgb(17, 34, 51)' } });
  heading.insert(0, [headingText]);

  const paragraph = new Y.XmlElement('paragraph');
  const body = new Y.XmlText();
  body.insert(0, 'plain then ');
  body.insert(11, 'coloured', { textStyle: { color: 'rgb(17, 34, 51)' } });
  body.insert(19, ' then bold', { bold: {} });
  paragraph.insert(0, [body]);

  fragment.insert(0, [heading, paragraph]);
  return doc;
}

describe('derive with a textStyle mark in the stored body', () => {
  it('extracts the full plain text instead of throwing on the unknown mark', () => {
    const doc = bodyWithTextStyle();
    const { text } = deriveNoteContentFromYDoc(doc);

    expect(text).toContain('Quarterly review');
    expect(text).toContain('plain then coloured then bold');
    doc.destroy();
  });

  it('serializes markdown rather than degrading to null', () => {
    // What the markdown looks like is editor-markdown's contract; what matters here is that the
    // snapshot is produced at all — a throw would leave content_markdown null on every save.
    const doc = bodyWithTextStyle();
    const errors: unknown[] = [];
    const { markdown } = deriveNoteContentFromYDoc(doc, { onMarkdownError: e => errors.push(e) });

    expect(errors).toEqual([]);
    expect(markdown).toContain('## Quarterly review');
    expect(markdown).toContain('plain then coloured');
    doc.destroy();
  });

  it('derives the title line, so a title-following note is no longer left stale', () => {
    const doc = bodyWithTextStyle();
    const { firstLine } = deriveNoteContentFromYDoc(doc);

    expect(firstLine).toBe('Quarterly review');
    doc.destroy();
  });

  // The client's Yjs binding deletes text it cannot parse (pinned in app-client). The server path
  // must never mutate the document at all, whatever it meets.
  it('leaves the CRDT state byte-identical — derivation reads, it never rewrites', () => {
    const doc = bodyWithTextStyle();
    const before = Y.encodeStateAsUpdate(doc);

    deriveNoteContentFromYDoc(doc);

    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    // Same answer from the encoded-update entry point the note store actually calls.
    expect(deriveNoteContentFromState(before)).toEqual(deriveNoteContentFromYDoc(doc));
    doc.destroy();
  });
});
