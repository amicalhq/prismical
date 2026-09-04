import type { SkillConfig } from '@prismical/app-contracts';

export const DEFAULT_SKILL_CONFIG: SkillConfig = {
  editingOptions: 'append-section',
  surface: ['dock'],
  defaultSkill: false,
  modeAgnosticPrompt: false,
};

type SkillFile = { name: string; description: string; body: string; config: SkillConfig };

/** JSON scalar values are valid YAML and safely preserve newlines and punctuation. */
export function skillToMarkdown(skill: SkillFile): string {
  return `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\nprismical: ${JSON.stringify(skill.config)}\n---\n\n${skill.body}`;
}

/** Preserve Prismical execution settings while accepting ordinary prompt-only Markdown. */
export function skillFromMarkdown(content: string, fallbackName: string): SkillFile {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?/.exec(content);
  const fields = new Map<string, string>();
  for (const line of frontmatter?.[1]?.split(/\r?\n/) ?? []) {
    const match = /^(name|description|prismical):\s*(.*)$/.exec(line);
    if (match) fields.set(match[1]!, match[2]!);
  }
  const scalar = (key: string, fallback: string) => {
    const value = fields.get(key);
    return value?.startsWith('"') ? String(JSON.parse(value)) : (value ?? fallback);
  };
  const config = fields.has('prismical')
    ? JSON.parse(fields.get('prismical')!)
    : DEFAULT_SKILL_CONFIG;
  if (!config || typeof config !== 'object' || !Array.isArray(config.surface))
    throw new Error('Invalid skill config');
  return {
    name: scalar('name', fallbackName),
    description: scalar('description', ''),
    body: frontmatter ? content.slice(frontmatter[0].length) : content,
    config,
  };
}
