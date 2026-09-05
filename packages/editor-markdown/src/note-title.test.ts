import { describe, expect, it } from 'vitest';
import { firstNoteLine } from './note-title.js';
import { markdownToTiptapJson } from './index.js';

describe('firstNoteLine', () => {
  it.each([
    ['\n\n# **Project** [launch](https://example.com)\n\nDetails', 'Project launch'],
    ['- Ship the feature\n- Follow up', 'Ship the feature'],
    ['> Planning notes\n\nMore', 'Planning notes'],
    ['![image](https://example.com/a.png)\n\nActual title', 'Actual title'],
    ['   \n\n', ''],
  ])('extracts readable text from %s', (markdown, title) => {
    expect(firstNoteLine(markdownToTiptapJson(markdown))).toBe(title);
  });
  it('respects hard line breaks without changing the document', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'First   line' },
            { type: 'hardBreak' },
            { type: 'text', text: 'Second line' },
          ],
        },
      ],
    };
    const before = JSON.stringify(doc);
    expect(firstNoteLine(doc)).toBe('First line');
    expect(JSON.stringify(doc)).toBe(before);
  });
  // The walk stops at the first non-empty line instead of flattening the whole document, so the
  // line boundaries it honours are worth pinning: a newline INSIDE a text node ends a line just
  // like a hardBreak, and empty leading blocks are skipped rather than returned.
  it('ends the line at a newline inside a single text node', () => {
    expect(firstNoteLine({ type: 'paragraph', content: [{ type: 'text', text: 'a\nb' }] })).toBe(
      'a'
    );
  });
  it('skips empty and whitespace-only leading blocks', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [] },
        { type: 'paragraph', content: [{ type: 'text', text: '   ' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'real title' }] },
      ],
    };
    expect(firstNoteLine(doc)).toBe('real title');
  });
  it('does not return content from beyond the first non-empty line', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
      ],
    };
    expect(firstNoteLine(doc)).toBe('first');
  });
  it('caps graphemes without splitting an emoji or a combining character', () => {
    const grapheme = '👩🏽‍💻';
    expect(firstNoteLine({ type: 'text', text: grapheme.repeat(90) })).toBe(grapheme.repeat(80));
    expect(firstNoteLine({ type: 'text', text: 'e\u0301'.repeat(90) })).toBe('e\u0301'.repeat(80));
  });
});
