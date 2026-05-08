import { z } from "zod";
import { createRouter, procedure } from "../trpc";
import FoldersService from "../../services/folders-service";

const service = () => FoldersService.getInstance();

const ListSchema = z.object({
  sortBy: z.enum(["createdAt", "name"]).optional().default("createdAt"),
  search: z.string().optional(),
});

export const foldersRouter = createRouter({
  list: procedure.input(ListSchema).query(({ input }) => service().list(input)),

  listFavorites: procedure.query(() => service().listFavorites()),

  listWithCounts: procedure
    .input(ListSchema)
    .query(({ input }) => service().listWithCounts(input)),

  getById: procedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ input }) => {
      const f = await service().getById(input.id);
      if (!f) throw new Error("Folder not found");
      return f;
    }),

  create: procedure
    .input(z.object({ name: z.string() }))
    .mutation(({ input }) => service().createFolder(input)),

  update: procedure
    .input(
      z.object({
        id: z.number().int(),
        name: z.string().optional(),
        isFavorite: z.boolean().optional(),
      }),
    )
    .mutation(({ input: { id, ...patch } }) =>
      service().updateFolder(id, patch),
    ),

  delete: procedure
    .input(z.object({ id: z.number().int() }))
    .mutation(({ input }) => service().deleteFolder(input.id)),
});
