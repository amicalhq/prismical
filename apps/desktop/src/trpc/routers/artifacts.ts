import { z } from "zod";
import { createRouter, procedure } from "../trpc";
import { getLatestArtifactByNote } from "../../db/artifacts";

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
});
