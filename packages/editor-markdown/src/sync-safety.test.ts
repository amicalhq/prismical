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
