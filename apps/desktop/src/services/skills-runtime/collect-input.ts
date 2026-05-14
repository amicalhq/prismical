import { eq, asc } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as Y from "yjs";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import {
  notes,
  meetings,
  transcriptSegments,
  yjsUpdates,
} from "@/db/schema";
import { tiptapJsonToMarkdown } from "@/services/notes/tiptap-markdown";
import { extractPlainText } from "./extract-plain-text";
import { COLLAB_FRAGMENT_NAME } from "@/services/notes/markdown-to-ydoc";
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
  // Skills need the FRESHEST note state, so we replay yjs_updates into a
  // transient Y.Doc here rather than reading the markdown sidecar (which
  // the renderer debounces by ~1.5s). materializeNoteContent returns both
  // the markdown projection and a plain-text rendering for the diff.
  const { markdown: noteMarkdown, plainText: notePlainText } =
    await materializeNoteContent(db, ctx.noteId);

  const transcript = await loadTranscript(db, ctx.noteId);

  return {
    noteMarkdown,
    notePlainText,
    transcript,
    selectionText: ctx.selectionText ?? null,
  };
}

// Reconstruct the note's freshest TipTap state by replaying yjs_updates
// rows into a transient Y.Doc, then read the canonical XmlFragment. We
// avoid the notes.content markdown sidecar here because it's debounced
// ~1.5s — a user who edits and immediately runs a skill would otherwise
// see stale input. Replay is bounded by compaction (PRSM-56 §7.4).
async function materializeNoteContent(
  db: LibSQLDatabase<Record<string, unknown>>,
  noteId: number,
): Promise<{ markdown: string; plainText: string }> {
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
      const fragment = ydoc.getXmlFragment(COLLAB_FRAGMENT_NAME);
      const json = yXmlFragmentToProsemirrorJSON(fragment);
      return {
        markdown: tiptapJsonToMarkdown(json),
        plainText: extractPlainText(json),
      };
    } finally {
      ydoc.destroy();
    }
  }

  // Fall back to notes.content (already markdown) for notes with no Yjs
  // state yet — freshly seeded fixtures, test setups. plainText is
  // derived via a lightweight strip; no parser needed.
  const [row] = await db
    .select({ content: notes.content })
    .from(notes)
    .where(eq(notes.id, noteId))
    .limit(1);
  const markdown = row?.content ?? "";
  return { markdown, plainText: stripMarkdownLite(markdown) };
}

// Lightweight markdown-to-plain-text for the fallback path only (notes
// without Yjs state). Not a parser; strips the most common syntax.
function stripMarkdownLite(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/^>\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "");
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
