import { z } from "zod";
import type { CreateSkillInput } from "@/services/skills-service";

const ModeSchema = z.enum(["append-section", "replace-doc", "inline-rewrite"]);
const SurfaceSchema = z.enum(["dock", "inline"]);

export const SkillJsonImportSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullish(),
  iconUrl: z.string().nullish(),
  body: z.string().min(1),
  config: z.object({
    editingOptions: ModeSchema,
    surface: z.array(SurfaceSchema).min(1),
    modelPreference: z
      .object({ instanceId: z.string(), modelId: z.string() })
      .optional(),
    defaultSkill: z.boolean().optional(),
    // Per-skill input policy. Omitted = all flags default off.
    inputs: z
      .object({
        transcript: z.boolean().optional(),
      })
      .optional(),
  }),
  metadata: z.record(z.string(), z.unknown()).optional(),
  allowedTools: z.array(z.string()).nullish(),
});

export function skillFromJson(raw: unknown): CreateSkillInput {
  const parsed = SkillJsonImportSchema.parse(raw);
  return {
    slug: parsed.slug,
    name: parsed.name,
    description: parsed.description ?? null,
    iconUrl: parsed.iconUrl ?? null,
    body: parsed.body,
    config: parsed.config,
    metadata: parsed.metadata,
    allowedTools: parsed.allowedTools ?? null,
  };
}
