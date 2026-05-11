import { z } from "zod";
import { createRouter, procedure } from "../trpc";
import {
  getLatestArtifactByNote,
  listArtifactsByNote,
  listArtifactsByNoteAndSkill,
  updateArtifactContent,
} from "../../db/artifacts";
import { db } from "../../db";

export const artifactsRouter = createRouter({
  // v0.3 compat — drives the AI Summary tab in note-wrapper.tsx.
  // Retired by Plan 5 when the sparkle button replaces the tab.
  getByNote: procedure
    .input(
      z.object({
        noteId: z.number().int().positive(),
        kind: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      return await getLatestArtifactByNote(input.noteId, input.kind);
    }),

  updateContent: procedure
    .input(
      z.object({
        artifactId: z.string().min(1),
        content: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const updated = await updateArtifactContent(
        input.artifactId,
        input.content,
      );
      if (!updated) {
        throw new Error("Artifact not found");
      }
      return updated;
    }),

  // PRSM-2 audit-log queries — used by Plan 3 runtime and Plan 6 Skills page.
  listByNote: procedure
    .input(z.object({ noteId: z.number().int().positive() }))
    .query(async ({ input }) => {
      return await listArtifactsByNote(db, input.noteId);
    }),

  listByNoteAndSkill: procedure
    .input(
      z.object({
        noteId: z.number().int().positive(),
        skillId: z.string().min(1),
      }),
    )
    .query(async ({ input }) => {
      return await listArtifactsByNoteAndSkill(
        db,
        input.noteId,
        input.skillId,
      );
    }),
});
