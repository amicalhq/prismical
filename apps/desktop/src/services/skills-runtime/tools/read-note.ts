import { tool } from "ai";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { notes } from "@/db/schema";

interface CreateReadNoteToolOpts {
  db: LibSQLDatabase<Record<string, unknown>>;
  noteId: number;
}

// `read_note` exposes the note title + body as plain text. The body is
// extracted from notes.content (Lexical editor-state JSON) by walking the
// tree and concatenating text nodes with paragraph breaks. The agent does
// not need formatted markdown — plain text suffices for reasoning.
export function createReadNoteTool(opts: CreateReadNoteToolOpts) {
  return tool({
    description:
      "Read the current note's title and body text. Returns { title, body }.",
    inputSchema: z.object({}),
    execute: async () => {
      const [row] = await opts.db
        .select({ title: notes.title, content: notes.content })
        .from(notes)
        .where(eq(notes.id, opts.noteId))
        .limit(1);
      if (!row) {
        throw new Error(`Note not found: ${opts.noteId}`);
      }
      return {
        title: row.title,
        body: row.content ? extractPlainText(row.content) : "",
      };
    },
  });
}

// Walks a Lexical editor-state JSON and returns its concatenated text.
// Paragraph / heading nodes are separated by "\n\n"; list items by "\n".
function extractPlainText(stateJson: string): string {
  try {
    const parsed = JSON.parse(stateJson);
    const root = parsed?.root;
    if (!root || !Array.isArray(root.children)) return "";
    return root.children
      .map((child: unknown) => extractNodeText(child as LexicalNodeLike))
      .filter((text: string) => text.length > 0)
      .join("\n\n");
  } catch {
    return "";
  }
}

interface LexicalNodeLike {
  type?: string;
  text?: string;
  children?: LexicalNodeLike[];
}

function extractNodeText(node: LexicalNodeLike): string {
  if (typeof node.text === "string") return node.text;
  if (Array.isArray(node.children)) {
    const inner = node.children.map(extractNodeText).join("");
    return inner;
  }
  return "";
}
