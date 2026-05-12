import { z } from "zod";
import { createRouter, procedure } from "../trpc";
import SkillsService from "@/services/skills-service";
import { runSkill } from "@/services/skills-runtime/skill-runner";
import { InFlightRegistry } from "@/services/skills-runtime/in-flight-registry";
import { getSettingsSection } from "@/db/app-settings";
import { SkillRunError } from "@/services/skills-runtime/errors";

const ModeSchema = z.enum([
  "append-section",
  "replace-doc",
  "inline-rewrite",
]);

export const skillRunsRouter = createRouter({
  run: procedure
    .input(
      z.object({
        noteId: z.number().int().positive(),
        skillSlug: z.string().min(1),
        modeOverride: ModeSchema.optional(),
        refineInstruction: z.string().optional(),
        previousOutput: z.string().optional(),
        selectionText: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const skill = await SkillsService.getInstance().getBySlug(input.skillSlug);
      if (!skill) {
        throw new SkillRunError(`Skill not found: ${input.skillSlug}`);
      }

      // Resolve the model: skill.config.modelPreference wins; user default fallback.
      const modelDefaults = await getSettingsSection("modelDefaults");
      const modelSelection =
        skill.config.modelPreference ?? modelDefaults?.formatting;
      if (!modelSelection) {
        throw new SkillRunError(
          "No formatting model configured. Set one in Settings → AI Models.",
        );
      }

      const mode = input.modeOverride ?? skill.config.editingOptions;
      const registry = InFlightRegistry.getInstance();
      const controller = registry.start(input.noteId, skill.slug);

      try {
        return await runSkill({
          skill,
          noteId: input.noteId,
          mode,
          refineInstruction: input.refineInstruction,
          previousOutput: input.previousOutput,
          selectionText: input.selectionText,
          modelInstanceId: modelSelection.instanceId,
          modelId: modelSelection.modelId,
          signal: controller.signal,
        });
      } finally {
        registry.finish(input.noteId);
      }
    }),

  cancel: procedure
    .input(z.object({ noteId: z.number().int().positive() }))
    .mutation(({ input }) => {
      const cancelled = InFlightRegistry.getInstance().cancel(input.noteId);
      return { cancelled };
    }),

  getInFlight: procedure
    .input(z.object({ noteId: z.number().int().positive() }))
    .query(({ input }) =>
      InFlightRegistry.getInstance().getInFlight(input.noteId),
    ),
});
