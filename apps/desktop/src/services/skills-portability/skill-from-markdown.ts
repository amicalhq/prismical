import matter from "gray-matter";
import { SkillJsonImportSchema } from "./skill-from-json";
import type { CreateSkillInput } from "@/services/skills-service";

export function skillFromMarkdown(content: string): CreateSkillInput {
  const { data, content: body } = matter(content);
  const merged = {
    slug: data.slug,
    name: data.name,
    description: data.description,
    iconUrl: data.iconUrl,
    body: body.trim(),
    config: {
      editingOptions: data.editingOptions,
      surface: data.surface ?? ["dock"],
      defaultSkill: data.defaultSkill,
    },
    metadata: data.metadata,
    allowedTools: data.allowedTools,
  };
  return SkillJsonImportSchema.parse(merged);
}
