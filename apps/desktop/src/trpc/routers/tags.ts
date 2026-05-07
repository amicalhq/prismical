import { z } from "zod";
import { createRouter, procedure } from "../trpc";
import TagsService from "../../services/tags-service";

const service = TagsService.getInstance();

const ListSchema = z.object({
  sortBy: z.enum(["createdAt", "name"]).optional().default("createdAt"),
  search: z.string().optional(),
});

const HexColor = z.string().regex(/^#[0-9a-f]{6}$/i);

export const tagsRouter = createRouter({
  list: procedure.input(ListSchema).query(({ input }) => service.list(input)),

  listRecent: procedure
    .input(z.object({ limit: z.number().int().positive().max(50).default(5) }))
    .query(({ input }) => service.listRecent(input.limit)),

  listFavorites: procedure.query(() => service.listFavorites()),

  listWithCounts: procedure
    .input(ListSchema)
    .query(({ input }) => service.listWithCounts(input)),

  getForNote: procedure
    .input(z.object({ noteId: z.number().int() }))
    .query(({ input }) => service.getForNote(input.noteId)),

  getById: procedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ input }) => {
      const t = await service.getById(input.id);
      if (!t) throw new Error("Tag not found");
      return t;
    }),

  create: procedure
    .input(z.object({ name: z.string(), color: HexColor.optional() }))
    .mutation(({ input }) => service.createTag(input)),

  update: procedure
    .input(
      z.object({
        id: z.number().int(),
        name: z.string().optional(),
        color: HexColor.optional(),
        isFavorite: z.boolean().optional(),
      }),
    )
    .mutation(({ input: { id, ...patch } }) => service.updateTag(id, patch)),

  delete: procedure
    .input(z.object({ id: z.number().int() }))
    .mutation(({ input }) => service.deleteTag(input.id)),

  attach: procedure
    .input(z.object({ noteId: z.number().int(), tagId: z.number().int() }))
    .mutation(({ input }) => service.attachTag(input.noteId, input.tagId)),

  detach: procedure
    .input(z.object({ noteId: z.number().int(), tagId: z.number().int() }))
    .mutation(({ input }) => service.detachTag(input.noteId, input.tagId)),
});
