/** A title follows document lines, never viewport wrapping or Markdown punctuation. */
interface TitleNode {
  type?: string;
  text?: string;
  content?: TitleNode[];
}

const BLOCK = /^(paragraph|heading|codeBlock|tableCell|tableHeader)$/;

/**
 * Constructed once, not per call. This runs on every editor `update` (i.e. every keystroke) for
 * a title-following note, and building an ICU segmenter each time was pure overhead.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * The first non-empty document line, capped at 80 graphemes.
 *
 * Walks only as far as it needs to. The previous implementation concatenated the WHOLE document,
 * split it, normalised every line, and then took the first non-empty one — O(document) per
 * keystroke on a long note. This stops at the first line that has content, so cost is bounded by
 * that line rather than by the document.
 */
export function firstNoteLine(doc: unknown): string {
  let line = '';
  let done = false;

  // Returns true once a complete non-empty line has been closed off, which unwinds the walk.
  const walk = (input: unknown): boolean => {
    if (done || !input || typeof input !== 'object') return done;
    const node = input as TitleNode;

    if (node.type === 'text') {
      if (typeof node.text !== 'string') return false;
      // A text node can carry newlines of its own, and each one closes a line exactly as a
      // hardBreak does — the old whole-document split saw them, so this must too.
      const parts = node.text.split(/\r?\n/);
      for (let i = 0; i < parts.length; i++) {
        line += parts[i];
        if (i === parts.length - 1) break;
        if (line.replace(/\s+/g, ' ').trim()) return (done = true);
        line = '';
      }
      return false;
    }
    // A hard break ends the line in place; anything gathered so far may already be the answer.
    if (node.type === 'hardBreak') {
      if (line.replace(/\s+/g, ' ').trim()) return (done = true);
      line = '';
      return false;
    }

    for (const child of Array.isArray(node.content) ? node.content : []) {
      if (walk(child)) return true;
    }

    // Leaving a block closes its line, exactly like the trailing "\n" the old version appended.
    if (BLOCK.test(node.type ?? '')) {
      if (line.replace(/\s+/g, ' ').trim()) return (done = true);
      line = '';
    }
    return false;
  };

  walk(doc);

  const first = line.replace(/\s+/g, ' ').trim();
  if (!first) return '';
  return Array.from(GRAPHEMES.segment(first))
    .slice(0, 80)
    .map(part => part.segment)
    .join('');
}
