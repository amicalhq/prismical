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
  // Boolean flags are emitted only when `=== true` — the form writes `false`
  // unconditionally for every user-authored skill, and emitting that into
  // exported YAML would clutter the output for the no-opt-ins common case.
  if (skill.description != null) {
    frontmatter.description = skill.description;
  }
  if (skill.config.defaultSkill === true) {
    frontmatter.defaultSkill = true;
  }
  if (skill.config.modeAgnosticPrompt === true) {
    frontmatter.modeAgnosticPrompt = true;
  }
  // Per-skill input policy — only emit the keys that are explicitly set, so
  // the YAML stays minimal for the common "no opt-ins" case.
  if (skill.config.inputs?.transcript != null) {
    frontmatter.inputs = { transcript: skill.config.inputs.transcript };
  }
  return matter.stringify(skill.body, frontmatter);
}
