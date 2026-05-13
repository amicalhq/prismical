import { eq, asc } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { notes, meetings, transcriptSegments } from "@/db/schema";
import { lexicalStateToMarkdown } from "@/services/notes/lexical-to-markdown";
import { extractPlainText } from "./extract-plain-text";
import type { SkillRunContext } from "./skill-context";

// Deterministic context for the skill. The skill author declared the mode
// via skill.config.editingOptions; we know what the skill needs from that
// plus the run-time ctx — no agentic decision required.
export interface SkillInput {
  // Markdown render of the note's Lexical state. Always populated.
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
  const [noteRow] = await db
    .select({ content: notes.content })
    .from(notes)
    .where(eq(notes.id, ctx.noteId))
    .limit(1);

  const stateJson = noteRow?.content ?? "";
  const noteMarkdown = stateJson ? lexicalStateToMarkdown(stateJson) : "";
  const notePlainText = stateJson ? extractPlainText(stateJson) : "";

  const transcript = await loadTranscript(db, ctx.noteId);

  return {
    noteMarkdown,
    notePlainText,
    transcript,
    selectionText: ctx.selectionText ?? null,
  };
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
