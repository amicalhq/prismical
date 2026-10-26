import { describe, expect, it } from 'vitest';
import { markdownToTiptapJson } from './tiptap-markdown';
import { documentSyncProblem, markdownSyncProblem } from './sync-safety';

describe('lossless sync boundary', () => {
  it.each([
    'hello',
    'if a < b and c > d',
    '`![literal](image.png)`',
    '```md\n![literal](image.png)\n```',
    '# Heading\n\nA **bold** paragraph.',
    '- one\n- two',
    '> quote',
    '```ts\nconst x = 1;\n```',
  ])('allows supported content: %s', text => {
    expect(markdownSyncProblem(text)).toBeNull();
    expect(documentSyncProblem(markdownToTiptapJson(text) as object)).toBeNull();
  });
  it.each([
    '![image](file.png)',
    '\\` ![image](file.png) \\`',
    'Text\n\n[unused]: https://example.com',
    '[[private note]]',
    '<!-- keep -->',
    '<span>keep</span>',
    '> [!note]\ncallout',
    '| h |\n|---|\n| **bold** |',
  ])('rejects content that would be lost: %s', text => {
    expect(markdownSyncProblem(text)).not.toBeNull();
  });
  it('rejects a rich mark that Markdown export hides', () => {
    expect(
      documentSyncProblem({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Keep highlight', marks: [{ type: 'highlight' }] }],
          },
        ],
      })
    ).not.toBeNull();
  });
});

it('does not discard non-default attributes when comparing rich content', () => {
  expect(documentSyncProblem({ type: 'doc', content: [{ type: 'paragraph', attrs: { textAlign: 'center' }, content: [{ type: 'text', text: 'Aligned' }] }] })).not.toBeNull();
});

it.each(['- one\n- two', '# Heading', '> quote', '```ts\nconst x = 1;\n```'])('allows the editor typing paragraph after %s', text => {
  const doc = markdownToTiptapJson(text) as { content: object[] };
  doc.content.push({ type: 'paragraph' });
  expect(documentSyncProblem(doc)).toBeNull();
});

it.each([
  { type: 'paragraph', attrs: { textAlign: 'center' } },
  { type: 'paragraph', marks: [{ type: 'highlight' }] },
  { type: 'paragraph', content: [{ type: 'text', text: ' ' }] },
])('retains safety checks on meaningful trailing paragraphs', paragraph => {
  const doc = markdownToTiptapJson('- one') as { content: object[] };
  doc.content.push(paragraph);
  expect(documentSyncProblem(doc)).not.toBeNull();
});

it('does not discard multiple or interior empty paragraphs', () => {
  const doc = markdownToTiptapJson('- one') as { content: object[] };
  doc.content.push({ type: 'paragraph' }, { type: 'paragraph' });
  expect(documentSyncProblem(doc)).not.toBeNull();
  doc.content = [{ type: 'paragraph' }, ...doc.content.slice(0, 1)];
  expect(documentSyncProblem(doc)).not.toBeNull();
});

it.each([
  '- one\n- two',
  '1. one\n2. two',
  '- [ ] one\n- [x] two',
  '- parent\n  - child\n- sibling',
  '- first paragraph\n\n  second paragraph\n\n- next',
])('keeps list spacing compatible with document sync: %s', text => {
  const document = markdownToTiptapJson(text) as object;
  expect(documentSyncProblem(document)).toBeNull();
});
