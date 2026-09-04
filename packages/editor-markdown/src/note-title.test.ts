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
  it('caps graphemes without splitting an emoji or a combining character', () => {
    const grapheme = '👩🏽‍💻';
    expect(firstNoteLine({ type: 'text', text: grapheme.repeat(90) })).toBe(grapheme.repeat(80));
    expect(firstNoteLine({ type: 'text', text: 'e\u0301'.repeat(90) })).toBe('e\u0301'.repeat(80));
  });
});
