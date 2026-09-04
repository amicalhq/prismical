'use client';

import { Sparkles } from 'lucide-react';
import { useSkillsList, useSkillDiffStore } from '@prismical/app-client';
import { CLEANUP_SKILL_ID } from '@prismical/app-contracts';
import { skillDisplayDescription, skillDisplayName } from '../../lib/skill-presentation';
import type { ComposerSkill } from './ask-composer';
import { useTranslation } from 'react-i18next';

/** Ask pill-face width — the DockUnit animates to it. */
export const ASK_PILL_WIDTH = 332;

/**
 * The Ask unit's pill face: a composer-shaped placeholder — sparkle
 * icon + "Ask anything…" — that expands the unit into the Ask panel on click,
 * plus (on a note) the suggested-skill chip: the default dock skill with a
 * slash badge — ONE CLICK runs it (the run engine's Generating/review pill
 * takes over from there). Hidden off-note (skills edit the note in focus).
 */
export function AskPillFace({
  onClick,
  onPickSkill,
  noteId = null,
  runActive = false,
}: {
  onClick: () => void;
  /** Run this skill immediately (one click — no seed-then-send step). */
  onPickSkill?: (skill: ComposerSkill) => void;
  /** The note in focus, if any — gates the suggested-skill chip. */
  noteId?: string | null;
  /** A run is already in flight on this note — hide the chip so a second
   * click can't abort-and-rerun the model call. */
  runActive?: boolean;
}) {
  const { t } = useTranslation();
  const { data: allSkills = [] } = useSkillsList();
  const hasStagedCandidate = useSkillDiffStore(s =>
    noteId ? s.candidatesByNote.has(noteId) : false
  );
  const dockSkills = allSkills.filter(s => s.enabled && s.config.surface.includes('dock'));
  // Same default precedence as the sparkle slot: explicit default,
  // else Cleanup, else the first dock skill. No chip while a diff is staged.
  const suggested =
    noteId && onPickSkill && !hasStagedCandidate && !runActive
      ? (dockSkills.find(s => s.config.defaultSkill) ??
        dockSkills.find(s => s.id === CLEANUP_SKILL_ID) ??
        dockSkills[0] ??
        null)
      : null;

  return (
    <div className="flex h-full w-full items-center gap-1 pl-2 pr-1.5">
      <button
        type="button"
        onClick={onClick}
        aria-label={t('ask.title')}
        className="flex h-full min-w-0 flex-1 cursor-text items-center gap-2 text-left"
      >
        <Sparkles className="size-[15px] shrink-0 text-dock-ink-2" />
        {/* The pill face carries the SHORT invitation; the instructional
            placeholder (slash/@ grammar) belongs to the composer inside the
            panel. */}
        <span className="min-w-0 flex-1 truncate text-[13px] text-dock-ink-3">
          {t('ask.pillPlaceholder')}
        </span>
      </button>
      {suggested ? (
        <button
          type="button"
          title={skillDisplayDescription(suggested, t) || undefined}
          onClick={() => onPickSkill?.({ id: suggested.id, name: skillDisplayName(suggested, t) })}
          className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-dock-field pl-1 pr-2.5 text-xs font-medium text-dock-ink transition-[background-color,scale] hover:bg-dock-hover active:scale-[0.96]"
        >
          <span className="flex size-[18px] items-center justify-center rounded-[5px] bg-dock-surface text-[11px] font-semibold text-dock-ink-2">
            /
          </span>
          <span className="max-w-[110px] truncate">{skillDisplayName(suggested, t)}</span>
        </button>
      ) : null}
    </div>
  );
}
