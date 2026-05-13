import type { Skill } from "@/db/schema";

export interface SkillJsonExport {
  slug: string;
  name: string;
  description?: string | null;
  iconUrl?: string | null;
  body: string;
  config: Skill["config"];
  metadata?: Skill["metadata"];
  allowedTools?: string[] | null;
}

export function skillToJson(skill: Skill): SkillJsonExport {
  return {
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    iconUrl: skill.iconUrl,
    body: skill.body,
    config: skill.config,
    metadata: skill.metadata,
    allowedTools: skill.allowedTools,
  };
}
