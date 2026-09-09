'use client';

import { Sparkles } from 'lucide-react';
import {
  useEntitlements,
  useSkillsList,
  useSkillDiffStore,
  type SkillRunRecord,
} from '@prismical/app-client';
import { CLEANUP_SKILL_ID } from '@prismical/app-contracts';
import { skillDisplayDescription, skillDisplayName } from '../../lib/skill-presentation';
import { SkillRunStatus } from './ask-skill-run-turn';
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
  // Plan gate: on a plan without Ask the pill invites a skill run, not a question.
  const askAllowed = useEntitlements().entitlements.features.askAi;
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
        <div className="min-w-0 flex-1 [&_[data-slot=marker]]:text-xs">
          <SkillRunStatus compact run={activeRun} t={t} onReviewInNote={onClick} />
        </div>
        <button
          type="button"
          onClick={onClick}
          aria-label={t('ask.title')}
          className="shrink-0 rounded-lg p-2 text-dock-ink-2 hover:bg-dock-hover"
        >
          <Sparkles className="size-4" />
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
          {t(askAllowed ? 'ask.pillPlaceholder' : 'ask.gate.pill')}
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
