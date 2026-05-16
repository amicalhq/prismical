import { z } from "zod";
import { createRouter, procedure } from "../trpc";
import SkillsService from "@/services/skills-service";
import { runSkill } from "@/services/skills-runtime/skill-runner";
import { InFlightRegistry } from "@/services/skills-runtime/in-flight-registry";
import { getSettingsSection } from "@/db/app-settings";
import { SkillRunError } from "@/services/skills-runtime/errors";
import { appendArtifact } from "@/db/artifacts";
import { db } from "@/db";

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
      if (!skill.enabled) {
        // Defense-in-depth: the UI filters out disabled skills, but stale
        // clients or direct tRPC calls shouldn't execute them.
        throw new SkillRunError(`Skill is disabled: ${input.skillSlug}`);
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
        registry.finish(input.noteId, controller);
      }
    }),

  // Writes the audit row for a candidate the user has accepted. Only accepted
  // runs land in `artifacts`; the runner emits unpersisted candidates and this
  // mutation finalizes them. Reject is a client-only no-op.
  accept: procedure
    .input(
      z.object({
        noteId: z.number().int().positive(),
        skillSlug: z.string().min(1),
        mode: ModeSchema,
        // Lexical children array (already JSON-serialized by the client).
        content: z.string().min(1),
        rawMarkdown: z.string().min(1),
        modelId: z.string().min(1),
        modelInstanceId: z.string().min(1),
        providerType: z.string().min(1),
        refineInstruction: z.string().nullable(),
        selectionText: z.string().nullable(),
        reasoning: z.string().nullable(),
        // Token usage captured at run time (t-07). Optional — old clients
        // and non-LLM generators won't send it. Cost-on-rejected-runs is a
        // known limitation: only fires on accept.
        usage: z
          .object({
            inputTokens: z.number().int().nonnegative().optional(),
            outputTokens: z.number().int().nonnegative().optional(),
            totalTokens: z.number().int().nonnegative().optional(),
            raw: z.string().optional(),
          })
          .optional(),
        // Per-call cost in US dollars (t-16). Populated only for
        // OpenRouter runs. Null elsewhere.
        costUsd: z.number().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // We intentionally let a failed appendArtifact insert propagate (the
      // tRPC caller will surface "couldn't accept" to the user). Unlike
      // note-gen's audit row — which is observability-only — this row is
      // load-bearing: `append-section` mode uses `MAX(version) + 1` and the
      // partial unique index `artifacts_note_id_skill_id_version_append_unique`
      // depends on the insert succeeding to keep monotonic versioning
      // honest. Silently swallowing would risk duplicate-version races on
      // the next append-section accept.
      const row = await appendArtifact(db, {
        noteId: input.noteId,
        skillId: input.skillSlug,
        mode: input.mode,
        content: input.content,
        generator: "ai",
        modelId: input.modelId,
        meta: {
          instanceId: input.modelInstanceId,
          providerType: input.providerType,
          refineInstruction: input.refineInstruction,
          selectionText: input.selectionText,
          reasoning: input.reasoning,
        },
        usage: input.usage,
        costUsd: input.costUsd ?? null,
      });
      return {
        artifactId: row.id,
        version: row.version,
        generatedAt: row.generatedAt!.toISOString(),
      };
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
