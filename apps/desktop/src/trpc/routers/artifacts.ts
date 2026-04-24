import { z } from "zod";
import { createRouter, procedure } from "../trpc";
import {
  getLatestArtifactByNote,
  updateArtifactContent,
} from "../../db/artifacts";

export const artifactsRouter = createRouter({
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
});
