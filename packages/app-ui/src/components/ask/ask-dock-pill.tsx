'use client';

import { Sparkles, X } from 'lucide-react';
import { useSkillsList, useSkillDiffStore, type SkillRunRecord } from '@prismical/app-client';
import { CLEANUP_SKILL_ID } from '@prismical/app-contracts';
import { skillDisplayDescription, skillDisplayName } from '../../lib/skill-presentation';
import { Loader } from '../ai-elements/loader';
import type { ComposerSkill } from './ask-composer';
import { useTranslation } from 'react-i18next';

/** Ask pill-face width — the DockUnit animates to it. */
export const ASK_PILL_WIDTH = 332;

/**
 * The Ask unit's pill face: a composer-shaped placeholder — sparkle
 * icon + "Ask anything…" — that expands the unit into the Ask panel on click,
 * plus (on a note) the suggested-skill chip: the default dock skill with a
 * slash badge — ONE CLICK runs it. Hidden off-note (skills edit the note in
 * focus).
 *
 * While a skill run is in flight on the note the SAME face morphs into its
 * running state — spinner + "Running Cleanup…" + a Stop control — the way it
 * morphs into the review pill once a diff is staged. The width never changes,
 * so the row does not reflow; a click still expands into the thread, where
 * the run shows as a turn. (The mock leaves the collapsed pill unchanged
 * mid-run; this fills that gap so Stop is reachable without opening the panel.)
 */
export function AskPillFace({
  onClick,
  onPickSkill,
  noteId = null,
  activeRun = null,
}: {
  onClick: () => void;
  /** Run this skill immediately (one click — no seed-then-send step). */
  onPickSkill?: (skill: ComposerSkill) => void;
  /** The note in focus, if any — gates the suggested-skill chip. */
  noteId?: string | null;
  /** The note-body run currently in flight on this note (run feed) — the pill
   * shows it with a Stop, and the chip hides so a second click can't
   * abort-and-rerun the model call. */
  activeRun?: SkillRunRecord | null;
}) {
  const { t } = useTranslation();
  const { data: allSkills = [] } = useSkillsList();
  const hasStagedCandidate = useSkillDiffStore(s =>
    noteId ? s.candidatesByNote.has(noteId) : false
  );
  // Title-target skills (the naming skill) apply straight to the title from the title field —
  // they have nothing to review, so the Ask lanes don't offer them.
  const dockSkills = allSkills.filter(
    s => s.enabled && s.config.outputTarget !== 'note-title' && s.config.surface.includes('dock')
  );
  // Same default precedence as the run engine: explicit default,
  // else Cleanup, else the first dock skill. No chip while a diff is staged or a
  // run is in flight.
  const suggested =
    noteId && onPickSkill && !hasStagedCandidate && !activeRun
      ? (dockSkills.find(s => s.config.defaultSkill) ??
        dockSkills.find(s => s.id === CLEANUP_SKILL_ID) ??
        dockSkills[0] ??
        null)
      : null;

  if (activeRun) {
    return (
      <div className="flex h-full w-full items-center gap-1 pl-2 pr-1.5" data-skill-run="running">
        <button
          type="button"
          onClick={onClick}
          aria-label={t('ask.title')}
          className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        >
          <Loader size={15} className="shrink-0 text-dock-ink-2" />
          {/* No live region here: ARIA flattens button descendants, and the thread's turn already
              announces the same run. */}
          <span className="shimmer shimmer-duration-1400 min-w-0 flex-1 truncate text-[13px] text-dock-ink">
            {t('ask.skillRun.running', { name: activeRun.skillName })}
          </span>
        </button>
        <button
          type="button"
          onClick={activeRun.cancel}
          aria-label={t('ask.skillRun.stop', { name: activeRun.skillName })}
          title={t('ask.skillRun.stop', { name: activeRun.skillName })}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-dock-ink-2 transition-colors hover:bg-dock-hover hover:text-dock-ink active:scale-95"
        >
          <X className="size-4" />
        </button>
      </div>
    );
  }

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
