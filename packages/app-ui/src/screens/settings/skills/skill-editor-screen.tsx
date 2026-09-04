'use client';

import { AppLink as Link } from '../../../shell/app-link';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../ui/button';
import { useSkills } from './components/skills-store';
import { SkillForm } from './components/skill-form';

export function SkillEditorScreen({ skillId }: { skillId: string }) {
  const { t } = useTranslation();
  const { getById } = useSkills();
  const skill = getById(skillId);

  if (!skill) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <span className="text-4xl">✨</span>
        <p className="text-sm font-medium">{t('settings.skillLibrary.editor.missingTitle')}</p>
        <p className="mb-4 text-xs">{t('settings.skillLibrary.editor.missingDescription')}</p>
        <Button asChild variant="outline" size="sm">
          <Link href="/settings/skills">{t('settings.skillLibrary.editor.back')}</Link>
        </Button>
      </div>
    );
  }

  // Key by id so the form re-initialises its state when navigating between
  // different skills (e.g. after Clone) instead of keeping the previous values.
  return <SkillForm key={skill.id} mode="edit" existing={skill} />;
}
