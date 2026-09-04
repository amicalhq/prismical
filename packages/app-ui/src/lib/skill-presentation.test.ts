import { describe, expect, it } from 'vitest';
import { createApplicationI18nSync } from '@prismical/app-i18n';
import { skillDisplayDescription, skillDisplayName } from './skill-presentation';

const systemSkillIds = [
  'skl_cleanup',
  'skl_enhance',
  'skl_ask_summarize',
  'skl_ask_action_items',
  'skl_ask_decisions',
] as const;

describe('system skill presentation', () => {
  it('localizes every shipped system skill display name and description', () => {
    const { t } = createApplicationI18nSync('ja');

    for (const id of systemSkillIds) {
      const skill = { id, name: 'English name', description: 'English description' };
      expect(skillDisplayName(skill, t), id).not.toBe(skill.name);
      expect(skillDisplayDescription(skill, t), id).not.toBe(skill.description);
    }
  });

  it('preserves user-created skill content', () => {
    const { t } = createApplicationI18nSync('de');
    const skill = { id: 'user-skill', name: 'My skill', description: 'My description' };

    expect(skillDisplayName(skill, t)).toBe(skill.name);
    expect(skillDisplayDescription(skill, t)).toBe(skill.description);
  });
});
