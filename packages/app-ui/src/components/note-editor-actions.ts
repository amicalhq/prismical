import type { ChainedCommands, Editor, Range } from '@tiptap/react';
import {
  Code2,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Table2,
  Type,
} from 'lucide-react';

export const noteBlockActions = [
  {
    id: 'paragraph',
    label: 'Text',
    icon: Type,
    keywords: 'paragraph plain',
    apply: (c: ChainedCommands) => c.clearNodes(),
  },
  {
    id: 'heading1',
    label: 'Heading 1',
    icon: Heading1,
    keywords: 'h1 title',
    apply: (c: ChainedCommands) => c.clearNodes().setHeading({ level: 1 }),
  },
  {
    id: 'heading2',
    label: 'Heading 2',
    icon: Heading2,
    keywords: 'h2 subtitle',
    apply: (c: ChainedCommands) => c.clearNodes().setHeading({ level: 2 }),
  },
  {
    id: 'heading3',
    label: 'Heading 3',
    icon: Heading3,
    keywords: 'h3',
    apply: (c: ChainedCommands) => c.clearNodes().setHeading({ level: 3 }),
  },
  {
    id: 'bulletList',
    label: 'Bullet list',
    icon: List,
    keywords: 'unordered bullets',
    apply: (c: ChainedCommands) => c.toggleBulletList(),
  },
  {
    id: 'orderedList',
    label: 'Numbered list',
    icon: ListOrdered,
    keywords: 'ordered numbers',
    apply: (c: ChainedCommands) => c.toggleOrderedList(),
  },
  {
    id: 'taskList',
    label: 'To-do list',
    icon: ListTodo,
    keywords: 'task checkbox checklist todo',
    apply: (c: ChainedCommands) => c.toggleTaskList(),
  },
  {
    id: 'blockquote',
    label: 'Quote',
    icon: Quote,
    keywords: 'blockquote',
    apply: (c: ChainedCommands) => c.toggleBlockquote(),
  },
  {
    id: 'codeBlock',
    label: 'Code block',
    icon: Code2,
    keywords: 'code snippet',
    apply: (c: ChainedCommands) => c.toggleCodeBlock(),
  },
  {
    id: 'divider',
    label: 'Divider',
    icon: Minus,
    keywords: 'horizontal rule line',
    apply: (c: ChainedCommands) => c.setHorizontalRule(),
  },
  {
    id: 'table',
    label: 'Table',
    icon: Table2,
    keywords: 'grid rows columns',
    apply: (c: ChainedCommands) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
  },
] as const;
export type NoteBlockAction = (typeof noteBlockActions)[number];

export function canApplyBlock(editor: Editor, action: NoteBlockAction, range?: Range) {
  if (!editor.isEditable || (action.id === 'table' && editor.isActive('table'))) return false;
  const chain = editor.can().chain();
  if (range) chain.deleteRange(range);
  return action.apply(chain).run();
}

export function applyBlock(editor: Editor, action: NoteBlockAction, range?: Range) {
  if (!canApplyBlock(editor, action, range)) return false;
  const chain = editor.chain().focus();
  if (range) chain.deleteRange(range);
  return action.apply(chain).run();
}

export function supportsInlineSkill(editor: Editor) {
  const { empty, from, to, $from, $to } = editor.state.selection;
  if (empty || !$from.sameParent($to) || !$from.parent.isTextblock) return false;
  const text = editor.state.doc.textBetween(from, to, ' ');
  return !!text.trim() && text.length <= 50_000;
}

export function normalizeEditorLink(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return '';
  // Explicit schemes must be safe. Bare domains get HTTPS; whitespace is never a URL.
  if (/\s/.test(trimmed)) return null;
  const url = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(url);
    return ['https:', 'http:', 'mailto:', 'tel:'].includes(parsed.protocol) ? url : null;
  } catch {
    return null;
  }
}
