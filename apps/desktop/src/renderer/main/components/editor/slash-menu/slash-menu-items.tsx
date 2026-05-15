import { ReactNode } from "react";
import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Code2,
  Minus,
  Table as TableIcon,
} from "lucide-react";
import type { Editor, Range } from "@tiptap/core";

export interface SlashMenuItem {
  label: string;
  keywords: string[];
  icon: ReactNode;
  run: (editor: Editor, range: Range) => void;
}

export const SLASH_MENU_ITEMS: SlashMenuItem[] = [
  {
    label: "Heading 1",
    keywords: ["h1", "title", "heading"],
    icon: <Heading1 className="size-4" />,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleHeading({ level: 1 }).run(),
  },
  {
    label: "Heading 2",
    keywords: ["h2", "heading"],
    icon: <Heading2 className="size-4" />,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run(),
  },
  {
    label: "Heading 3",
    keywords: ["h3", "heading"],
    icon: <Heading3 className="size-4" />,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleHeading({ level: 3 }).run(),
  },
  {
    label: "Bullet list",
    keywords: ["ul", "bullet", "list"],
    icon: <List className="size-4" />,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    label: "Numbered list",
    keywords: ["ol", "ordered", "numbered", "list"],
    icon: <ListOrdered className="size-4" />,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    label: "Check list",
    keywords: ["todo", "checklist", "check", "list", "task"],
    icon: <ListChecks className="size-4" />,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    label: "Quote",
    keywords: ["quote", "blockquote"],
    icon: <Quote className="size-4" />,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    label: "Code block",
    keywords: ["code", "pre", "snippet"],
    icon: <Code2 className="size-4" />,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    label: "Divider",
    keywords: ["hr", "divider", "rule", "separator"],
    icon: <Minus className="size-4" />,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  {
    label: "Table",
    keywords: ["table", "grid"],
    icon: <TableIcon className="size-4" />,
    run: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
];

export function filterSlashItems(query: string): SlashMenuItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return SLASH_MENU_ITEMS;
  return SLASH_MENU_ITEMS.filter((item) => {
    if (item.label.toLowerCase().includes(q)) return true;
    return item.keywords.some((kw) => kw.toLowerCase().includes(q));
  });
}
