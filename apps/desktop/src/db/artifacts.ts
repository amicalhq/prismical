import { and, desc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "./index";
import {
  noteArtifacts,
  type NewNoteArtifact,
  type NoteArtifact,
} from "./schema";

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

// Replaces the single artifact for (noteId, kind) with new generated content,
// or inserts one if it doesn't exist yet. v1 invariant: at most one row per
// (noteId, kind). When versioning lands this becomes INSERT-with-version-bump.
export async function createOrReplaceArtifact(
  data: Omit<NewNoteArtifact, "id" | "createdAt" | "updatedAt"> & {
    kind?: string;
  },
): Promise<NoteArtifact> {
  const kind = data.kind ?? "summary";
  const existing = await getLatestArtifactByNote(data.noteId, kind);
  const now = new Date();

  if (existing) {
    const [updated] = await db
      .update(noteArtifacts)
      .set({
        content: data.content,
        generator: data.generator,
        modelId: data.modelId ?? null,
        meta: data.meta ?? null,
        generatedAt: data.generatedAt ?? now,
        updatedAt: now,
      })
      .where(eq(noteArtifacts.id, existing.id))
      .returning();
    return updated;
  }

  const [inserted] = await db
    .insert(noteArtifacts)
    .values({
      id: uuid(),
      noteId: data.noteId,
      kind,
      content: data.content,
      generator: data.generator,
      modelId: data.modelId ?? null,
      meta: data.meta ?? null,
      generatedAt: data.generatedAt ?? now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return inserted;
}

// Updates only the `content` field of an existing artifact — used by the
// editor's debounced save when the user edits the AI Summary surface. Doesn't
// touch generator/modelId/meta/generated_at since edits aren't regenerations.
export async function updateArtifactContent(
  artifactId: string,
  content: string,
): Promise<NoteArtifact | null> {
  const [updated] = await db
    .update(noteArtifacts)
    .set({
      content,
      updatedAt: new Date(),
    })
    .where(eq(noteArtifacts.id, artifactId))
    .returning();

  return updated ?? null;
}
