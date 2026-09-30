import MarkdownIt from 'markdown-it';
import { markdownToTiptapJson, tiptapJsonToMarkdown } from './tiptap-markdown.js';

function stable(value: unknown): string {
  return JSON.stringify(value, (key, v) => {
    if (key === 'attrs' && v && typeof v === 'object') {
      const attributes = Object.entries(v).filter(([, attribute]) => attribute !== null);
      return attributes.length ? Object.fromEntries(attributes.sort(([a], [b]) => a.localeCompare(b))) : undefined;
    }
    return v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v;
  });
}

/** Conservative boundary: no lossy replacement of existing rich content. */
export function documentSyncProblem(document: object): string | null {
  try {
    const markdown = tiptapJsonToMarkdown(document);
    if (stable(document) !== stable(markdownToTiptapJson(markdown))) {
      return 'This note contains formatting that cannot round-trip through Markdown.';
    }
    return markdownSyncProblem(markdown, false);
  } catch {
    return 'This note cannot be represented safely as Markdown.';
  }
}

/** Restrict sync to ordinary Markdown; never silently drop embedded or extension content. */
export function markdownSyncProblem(markdown: string, checkDocument = true): string | null {
  // Tokenize before conversion: conversion can already have dropped unsupported nodes.
  // The parser distinguishes escaped delimiters from actual code spans/fences.
  const parser = new MarkdownIt('commonmark', { html: true }).enable(['table', 'strikethrough']);
  const env: { references?: Record<string, unknown> } = {};
  const tokens = parser.parse(markdown, env);
  if (env.references && Object.keys(env.references).length) {
    return 'Reference definitions cannot be preserved by two-way sync yet.';
  }
  const pending = [...tokens];
  while (pending.length) {
    const token = pending.pop()!;
    if (token.type === 'image' || token.type === 'html_block' || token.type === 'html_inline') {
      return 'Images, embeds, and HTML are not supported by two-way sync yet.';
    }
    if (
      token.type === 'text' &&
      /\[\[|\]\]|%%|\[\^|\[!|\$\$|^\s*\^[-\w]+|\s\^[-\w]+\s*$/m.test(token.content)
    ) {
      return 'Extended Markdown is not supported by two-way sync yet.';
    }
    if (token.children) pending.push(...token.children);
  }
  try {
    if (checkDocument) return documentSyncProblem(markdownToTiptapJson(markdown) as object);
    return null;
  } catch {
    return 'This Markdown cannot be parsed safely.';
  }
}
