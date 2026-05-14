import matter from "gray-matter";
import type { Skill } from "@/db/schema";

export function skillToMarkdown(skill: Skill): string {
  const frontmatter: Record<string, unknown> = {
    slug: skill.slug,
    name: skill.name,
    editingOptions: skill.config.editingOptions,
    surface: skill.config.surface,
  };
  // Only include optional fields when they have meaningful values,
  // because js-yaml (used inside gray-matter) cannot serialize `undefined`.
  if (skill.description != null) {
    frontmatter.description = skill.description;
  }
  if (skill.config.defaultSkill != null) {
    frontmatter.defaultSkill = skill.config.defaultSkill;
  }
  if (skill.config.modeAgnosticPrompt != null) {
    frontmatter.modeAgnosticPrompt = skill.config.modeAgnosticPrompt;
  }
  // Per-skill input policy — only emit the keys that are explicitly set, so
  // the YAML stays minimal for the common "no opt-ins" case.
  if (skill.config.inputs?.transcript != null) {
    frontmatter.inputs = { transcript: skill.config.inputs.transcript };
  }
  return matter.stringify(skill.body, frontmatter);
}
