import { and, desc, eq } from "drizzle-orm";
import { db } from "./index";
import { noteArtifacts, type NoteArtifact } from "./schema";

// Returns the most-recently-touched artifact for a given note + kind, or null.
// `updated_at` is the tiebreaker (not `generated_at`) so that in-place user
// edits naturally promote the edited artifact to "latest." When versioning
// lands, this should switch to `ORDER BY version DESC` and the index should
// extend to `(note_id, kind, version DESC)`.
export async function getLatestArtifactByNote(
  noteId: number,
  kind = "summary",
): Promise<NoteArtifact | null> {
  const [row] = await db
    .select()
    .from(noteArtifacts)
    .where(
      and(eq(noteArtifacts.noteId, noteId), eq(noteArtifacts.kind, kind)),
    )
    .orderBy(desc(noteArtifacts.updatedAt))
    .limit(1);

  return row ?? null;
}
