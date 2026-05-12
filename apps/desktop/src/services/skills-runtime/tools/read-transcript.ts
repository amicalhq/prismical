import { tool } from "ai";
import { eq, asc } from "drizzle-orm";
import { z } from "zod";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { meetings, transcriptSegments } from "@/db/schema";

interface CreateReadTranscriptToolOpts {
  db: LibSQLDatabase<Record<string, unknown>>;
  noteId: number;
}

// `read_transcript` returns the concatenated transcript text from all meetings
// linked to this note. Returns { transcript: null } when no meeting is linked.
//
// Segments are ordered by segment_order to preserve the original turn sequence.
// The cleanup skill's prompt instructs the agent NOT to call this tool — it is
// in the registry (per spec §4) but unused for cleanup via prompt-level guidance.
export function createReadTranscriptTool(opts: CreateReadTranscriptToolOpts) {
  return tool({
    description:
      "Read the meeting transcript linked to this note. Returns { transcript } where transcript is the concatenated text of all transcript segments, or null if no meeting is linked.",
    inputSchema: z.object({}),
    execute: async () => {
      // Find meetings linked to this note
      const linkedMeetings = await opts.db
        .select({ id: meetings.id })
        .from(meetings)
        .where(eq(meetings.noteId, opts.noteId));

      if (linkedMeetings.length === 0) {
        return { transcript: null };
      }

      const meetingIds = linkedMeetings.map((m) => m.id);

      // Fetch all segments for each meeting, ordered by segment_order
      const allSegments: string[] = [];
      for (const meetingId of meetingIds) {
        const segments = await opts.db
          .select({ text: transcriptSegments.text })
          .from(transcriptSegments)
          .where(eq(transcriptSegments.meetingId, meetingId))
          .orderBy(asc(transcriptSegments.segmentOrder));
        for (const seg of segments) {
          allSegments.push(seg.text);
        }
      }

      if (allSegments.length === 0) {
        return { transcript: null };
      }

      return { transcript: allSegments.join("\n") };
    },
  });
}
