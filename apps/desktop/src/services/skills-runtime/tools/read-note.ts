import { tool } from "ai";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { notes } from "@/db/schema";
import { extractPlainText } from "../extract-plain-text";

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

