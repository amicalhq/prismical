import { z } from "zod";
import { createRouter, procedure } from "../trpc";
import SkillsService from "../../services/skills-service";
import {
  skillToJson,
  skillFromJson,
  skillToMarkdown,
  skillFromMarkdown,
} from "../../services/skills-portability";

const service = () => SkillsService.getInstance();

const ModeSchema = z.enum([
  "append-section",
  "replace-doc",
  "inline-rewrite",
]);
const SurfaceSchema = z.enum(["dock", "inline"]);

const ModelSelectionSchema = z.object({
  instanceId: z.string().min(1),
  modelId: z.string().min(1),
});

const ConfigSchema = z.object({
  editingOptions: ModeSchema,
  surface: z.array(SurfaceSchema).min(1),
  modelPreference: ModelSelectionSchema.optional(),
  defaultSkill: z.boolean().optional(),
});

export const skillsRouter = createRouter({
  list: procedure
    .input(z.object({ onlyEnabled: z.boolean().optional() }).optional())
    .query(({ input }) => service().list({ onlyEnabled: input?.onlyEnabled })),

  listForSurface: procedure
    .input(z.object({ surface: SurfaceSchema }))
    .query(({ input }) => service().listForSurface(input.surface)),

  getBySlug: procedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ input }) => {
      const s = await service().getBySlug(input.slug);
      if (!s) throw new Error("Skill not found");
      return s;
    }),

  getById: procedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      const s = await service().getById(input.id);
      if (!s) throw new Error("Skill not found");
      return s;
    }),

  create: procedure
    .input(
      z.object({
        slug: z.string().min(1),
        name: z.string().min(1),
        description: z.string().nullish(),
        iconUrl: z.string().nullish(),
        body: z.string().min(1),
        config: ConfigSchema,
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(({ input }) => service().createSkill(input)),

  update: procedure
    .input(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1).optional(),
        description: z.string().nullish(),
        iconUrl: z.string().nullish(),
        body: z.string().min(1).optional(),
        config: ConfigSchema.optional(),
        enabled: z.boolean().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(({ input: { id, ...patch } }) => service().updateSkill(id, patch)),

  delete: procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await service().deleteSkill(input.id);
      return { ok: true as const };
    }),

  clone: procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ input }) => service().cloneSkill(input.id)),

  setEnabled: procedure
    .input(z.object({ id: z.string().min(1), enabled: z.boolean() }))
    .mutation(({ input }) =>
      service().updateSkill(input.id, { enabled: input.enabled }),
    ),

  exportAsJson: procedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      const s = await service().getById(input.id);
      if (!s) throw new Error("Skill not found");
      return { json: skillToJson(s) };
    }),

  exportAsMarkdown: procedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      const s = await service().getById(input.id);
      if (!s) throw new Error("Skill not found");
      return { markdown: skillToMarkdown(s) };
    }),

  import: procedure
    .input(
      z.object({
        format: z.enum(["json", "markdown"]),
        content: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const createInput =
        input.format === "json"
          ? skillFromJson(JSON.parse(input.content))
          : skillFromMarkdown(input.content);
      return await service().createSkill(createInput);
    }),
});
