'use client';

import { useTranslation } from 'react-i18next';
import { MessageCircle, Sparkles } from 'lucide-react';
import { useSkillsList } from '@prismical/app-client';
import { useCurrentNote } from '../../shell/current-note-context';
import { askSkills } from '@prismical/app-client';
import { skillDisplayDescription, skillDisplayName } from '../../lib/skill-presentation';
import type { ComposerSkill } from './ask-composer';

/** Cap the empty-state skill row at three chips. */
const MAX_SKILL_CHIPS = 3;

const CHIP_CLASS =
  'flex min-h-[26px] items-center gap-1.5 rounded-lg border border-dock-line bg-[color-mix(in_srgb,var(--dock-field)_60%,transparent)] px-2.5 py-1 text-left text-xs text-dock-ink-2 transition-colors hover:bg-dock-hover hover:text-dock-ink';

/**
 * Empty-state suggestions for the Ask panel: a row of starter QUESTION
 * chips over a row of skill chips.
 *
 * Questions are fixed, context-aware starters (note open → about that note, and tapping one sends
 * IMMEDIATELY with the note attached as scope; off-note → about the whole workspace) — static
 * because nothing has been asked yet for a model to riff on; per-answer follow-ups are the
 * generated lane.
 *
 * Skills mirror the composer's two lanes: on a note (`canRunSkills`) the chips are the dock/slash
 * skills and tapping one INSERTS its `/skill` token so the user can add
 * guidance or just sends); off-note they fall back to the user's `ask`-surface skills, whose saved
 * prompt FILLS the composer for editing. Capped at {@link MAX_SKILL_CHIPS}; descriptions live in
 * the hover tooltip, never inline.
 */
export function AskSuggestions({
  canRunSkills,
  onAsk,
  onPickPrompt,
  onInsertSkill,
}: {
  /** A note is open and the skill-run lane exists — offer dock skills as `/` tokens. */
  canRunSkills: boolean;
  /** Send a starter question immediately, scoped to the given notes. */
  onAsk: (question: string, notes: { id: string; title: string }[]) => void;
  /** Fill the composer with an ask-surface skill's saved prompt (user edits, then sends). */
  onPickPrompt: (prompt: string) => void;
  /** Insert a dock skill's `/skill` token into the composer. */
  onInsertSkill: (skill: ComposerSkill) => void;
}) {
  const { t } = useTranslation();
  const { data: skills = [] } = useSkillsList();
  const { currentNote } = useCurrentNote();

  const questions = currentNote
    ? [t('ask.suggestions.noteSummary'), t('ask.suggestions.noteActions')]
    : [t('ask.suggestions.recentNotes'), t('ask.suggestions.openActions')];
  const questionNotes = currentNote
    ? [{ id: currentNote.noteId, title: currentNote.title }]
    : [];

  const dockSkills = canRunSkills
    ? skills.filter(s => s.enabled && s.config.surface.includes('dock')).slice(0, MAX_SKILL_CHIPS)
    : [];
  const promptSkills =
    dockSkills.length > 0
      ? []
      : askSkills(skills, { hasNote: Boolean(currentNote) }).slice(0, MAX_SKILL_CHIPS);

  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {questions.map(q => (
          <button
            key={q}
            type="button"
            onClick={() => onAsk(q, questionNotes)}
            className={CHIP_CLASS}
          >
            <MessageCircle className="size-3 shrink-0 text-dock-ink-3" />
            <span className="max-w-[260px]">{q}</span>
          </button>
        ))}
      </div>
      {dockSkills.length > 0 || promptSkills.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {dockSkills.map(s => (
            <button
              key={s.id}
              type="button"
              title={skillDisplayDescription(s, t) || undefined}
              onClick={() => onInsertSkill({ id: s.id, name: skillDisplayName(s, t) })}
              className={CHIP_CLASS}
            >
              <span className="flex size-4 shrink-0 items-center justify-center rounded-[5px] bg-dock-surface text-[10px] font-semibold text-dock-ink-2">
                /
              </span>
              <span className="max-w-[220px] truncate font-medium text-dock-ink">
                {skillDisplayName(s, t)}
              </span>
            </button>
          ))}
          {promptSkills.map(s => (
            <button
              key={s.id}
              type="button"
              title={skillDisplayDescription(s, t) || undefined}
              onClick={() => onPickPrompt(s.body)}
              className={CHIP_CLASS}
            >
              <Sparkles className="size-3 shrink-0 text-dock-ink-3" />
              <span className="max-w-[220px] truncate">{skillDisplayName(s, t)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
