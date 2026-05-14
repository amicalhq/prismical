import { eq, asc } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as Y from "yjs";
import {
  notes,
  meetings,
  transcriptSegments,
  yjsUpdates,
} from "@/db/schema";
import { tiptapJsonToMarkdown } from "@/services/notes/tiptap-markdown";
import { extractPlainText } from "./extract-plain-text";
import type { SkillRunContext } from "./skill-context";

// Deterministic context for the skill. The skill author declared the mode
// via skill.config.editingOptions; we know what the skill needs from that
// plus the run-time ctx — no agentic decision required.
export interface SkillInput {
  // Markdown render of the note's TipTap state. Always populated.
  noteMarkdown: string;
  // Plain-text render of the note. Used as the "before" side of the
  // replace-doc char diff; not fed into the prompt (markdown is richer).
  notePlainText: string;
  // Concatenated transcript segments from any meetings linked to this note,
  // null when there's no meeting. Skills can use or ignore it.
  transcript: string | null;
  // Selection text for inline-rewrite mode; null otherwise.
  selectionText: string | null;
}

export async function collectInput(
  db: LibSQLDatabase<Record<string, unknown>>,
  ctx: SkillRunContext,
): Promise<SkillInput> {
  // `notes.content` is a one-time seed snapshot — it's set at note creation
  // and never updated. The live editor state lives in `yjs_updates` (the
  // editor reads/writes via Yjs). Materializing here ensures every skill
  // run sees the current note, including content from previously-accepted
  // skill runs that wrote via the editor's Yjs sync.
  const stateJson = await materializeNoteContent(db, ctx.noteId);
  const noteMarkdown = stateJson ? tiptapJsonToMarkdown(stateJson) : "";
  const notePlainText = stateJson ? extractPlainText(stateJson) : "";

  const transcript = await loadTranscript(db, ctx.noteId);

  return {
    noteMarkdown,
    notePlainText,
    transcript,
    selectionText: ctx.selectionText ?? null,
  };
}

// Reconstruct the note's live TipTap state JSON by applying all stored Yjs
// updates. The editor's YjsSyncPlugin stores the TipTap editor-state JSON
// as a plain string inside a Y.Text named "content"; replaying the deltas
// gives us the current value. Falls back to the `notes.content` snapshot
// for notes that have no Yjs updates (e.g., freshly seeded fixtures).
async function materializeNoteContent(
  db: LibSQLDatabase<Record<string, unknown>>,
  noteId: number,
): Promise<string> {
  const updates = await db
    .select({ data: yjsUpdates.updateData })
    .from(yjsUpdates)
    .where(eq(yjsUpdates.noteId, noteId))
    .orderBy(asc(yjsUpdates.id));

  if (updates.length > 0) {
    const ydoc = new Y.Doc();
    try {
      for (const row of updates) {
        Y.applyUpdate(ydoc, new Uint8Array(row.data as Buffer));
      }
      const live = ydoc.getText("content").toString();
      if (live.length > 0) return live;
    } finally {
      ydoc.destroy();
    }
  }

  // Fall back to the snapshot for never-edited notes.
  const [row] = await db
    .select({ content: notes.content })
    .from(notes)
    .where(eq(notes.id, noteId))
    .limit(1);
  return row?.content ?? "";
}

async function loadTranscript(
  db: LibSQLDatabase<Record<string, unknown>>,
  noteId: number,
): Promise<string | null> {
  const linkedMeetings = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(eq(meetings.noteId, noteId));

  if (linkedMeetings.length === 0) return null;

  const segments: string[] = [];
  for (const m of linkedMeetings) {
    const rows = await db
      .select({ text: transcriptSegments.text })
      .from(transcriptSegments)
      .where(eq(transcriptSegments.meetingId, m.id))
      .orderBy(asc(transcriptSegments.segmentOrder));
    for (const r of rows) segments.push(r.text);
  }

  return segments.length === 0 ? null : segments.join("\n");
}
