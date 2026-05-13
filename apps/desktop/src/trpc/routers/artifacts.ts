import { z } from "zod";
import { createRouter, procedure } from "../trpc";
import {
  listArtifactsByNote,
  listArtifactsByNoteAndSkill,
} from "../../db/artifacts";
import { db } from "../../db";

export const artifactsRouter = createRouter({
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
