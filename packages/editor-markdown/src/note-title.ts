/** A title follows document lines, never viewport wrapping or Markdown punctuation. */
interface TitleNode {
  type?: string;
  text?: string;
  content?: TitleNode[];
}

export function firstNoteLine(doc: unknown): string {
  const text = (input: unknown): string => {
    if (!input || typeof input !== 'object') return '';
    const node = input as TitleNode;
    if (node.type === 'text') return typeof node.text === 'string' ? node.text : '';
    if (node.type === 'hardBreak') return '\n';
    const value = (Array.isArray(node.content) ? node.content : []).map(text).join('');
    return /^(paragraph|heading|codeBlock|tableCell|tableHeader)$/.test(node.type ?? '')
      ? `${value}\n`
      : value;
  };
  const first =
    text(doc)
      .split(/\r?\n/)
      .map(line => line.replace(/\s+/g, ' ').trim())
      .find(Boolean) ?? '';
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(first))
    .slice(0, 80)
    .map(part => part.segment)
    .join('');
}
