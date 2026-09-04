import { AppLink as Link } from '../../../shell/app-link';
import { useTranslation } from 'react-i18next';
import type { Skill } from '../mock-data';
import { skillDisplayDescription, skillDisplayName } from '../../../lib/skill-presentation';

interface SkillCardProps {
  skill: Skill;
}

// Faithful port of the desktop `SkillCard`: a plain card-link to the editor.
// Every skill (system included) opens its editor — system skills land there
// read-only. No badges or hover actions; the equal-height grid + two-line
// description clamp keep the cards uniform.
export function SkillCard({ skill }: SkillCardProps) {
  const { t } = useTranslation();
  const description = skillDisplayDescription(skill, t);
  return (
    <Link
      href={`/settings/skills/${skill.id}`}
      className="group flex h-full flex-col rounded-xl border bg-card p-4 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="mb-3 text-2xl leading-none">✨</div>
      <h3 className="truncate font-medium">{skillDisplayName(skill, t)}</h3>
      <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-sm text-muted-foreground">
        {description ? (
          description
        ) : (
          <span className="italic opacity-60">{t('settings.skillLibrary.card.noDescription')}</span>
        )}
      </p>
    </Link>
  );
}
