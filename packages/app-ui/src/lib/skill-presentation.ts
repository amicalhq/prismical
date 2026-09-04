import type { Skill } from '@prismical/app-contracts';
import type { ApplicationTFunction } from '@prismical/app-i18n';

const SYSTEM_SKILL_KEYS = {
  skl_name_note: { name: 'notes.nameNoteSkill', description: 'notes.nameNoteDescription' },
  skl_cleanup: {
    name: 'settings.skillLibrary.systemSkills.cleanupName',
    description: 'settings.skillLibrary.systemSkills.cleanupDescription',
  },
  skl_enhance: {
    name: 'settings.skillLibrary.systemSkills.enhanceName',
    description: 'settings.skillLibrary.systemSkills.enhanceDescription',
  },
  skl_ask_summarize: {
    name: 'settings.skillLibrary.systemSkills.summarizeName',
    description: 'settings.skillLibrary.systemSkills.summarizeDescription',
  },
  skl_ask_action_items: {
    name: 'settings.skillLibrary.systemSkills.actionItemsName',
    description: 'settings.skillLibrary.systemSkills.actionItemsDescription',
  },
  skl_ask_decisions: {
    name: 'settings.skillLibrary.systemSkills.decisionsName',
    description: 'settings.skillLibrary.systemSkills.decisionsDescription',
  },
} as const;

type SystemSkillId = keyof typeof SYSTEM_SKILL_KEYS;
type SkillPresentation = Pick<Skill, 'id' | 'name' | 'description'>;

function systemSkillKeys(skillId: string) {
  return SYSTEM_SKILL_KEYS[skillId as SystemSkillId];
}

export function skillDisplayName(skill: SkillPresentation, t: ApplicationTFunction): string {
  const keys = systemSkillKeys(skill.id);
  return keys ? t(keys.name) : skill.name;
}

export function skillDisplayDescription(skill: SkillPresentation, t: ApplicationTFunction): string {
  const keys = systemSkillKeys(skill.id);
  return keys ? t(keys.description) : skill.description;
}
