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
import { Loader } from '../ai-elements/loader';
import { DOCK_CHIP, DOCK_CHIP_ACCENT, DOCK_CHIP_ACCENT_BADGE, DOCK_CHIP_BADGE, DOCK_CTL_PRIMARY } from '../dock-chrome';
import type { ComposerSkill } from './ask-composer';
import { useTranslation } from 'react-i18next';

/** Ask pill-face width — the DockUnit animates to it. */
export const ASK_PILL_WIDTH = 332;

/** The recording→note action offered on the chip instead of the default skill. */
export interface RecordingSuggestion {
  /** "Generate notes" / "Enhance notes" (see `recordingSkillCopy`). */
  label: string;
  /** Tooltip saying what the run does to this note. */
  hint: string;
  onPick: () => void;
}

/**
 * The Ask unit's pill face: a composer-shaped placeholder — sparkle
 * icon + "Ask anything…" — that expands the unit into the Ask panel on click,
 * plus (on a note) the suggested-skill chip: the default dock skill with a
 * slash badge — ONE CLICK runs it. Hidden off-note (skills edit the note in
 * focus). A recording whose transcript is ready but not yet in the note takes
 * the chip over (`recordingSuggestion`), so the action stays on screen after
 * the transcript panel collapses.
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
  recordingSuggestion = null,
}: {
  onClick: () => void;
  /** Run this skill immediately (one click — no seed-then-send step). */
  onPickSkill?: (skill: ComposerSkill) => void;
  /** Takes precedence over the default skill while the note has a recording to fold in. */
  recordingSuggestion?: RecordingSuggestion | null;
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
  // A pending recording outranks the default skill: it is the one thing the user most likely
  // came back to do. Same gates as the skill chip (no chip while a diff is staged or a run is in
  // flight).
  const recordingChip =
    noteId && recordingSuggestion && !hasStagedCandidate && !activeRun ? recordingSuggestion : null;
  const chip = recordingChip
    ? { kind: 'recording' as const, label: recordingChip.label, hint: recordingChip.hint, onClick: recordingChip.onPick }
    : suggested
      ? {
          kind: 'skill' as const,
          label: skillDisplayName(suggested, t),
          hint: skillDisplayDescription(suggested, t) || undefined,
          onClick: () => onPickSkill?.({ id: suggested.id, name: skillDisplayName(suggested, t) }),
        }
      : null;

  if (activeRun) {
    return (
      <div className="flex h-full w-full items-center gap-1 pl-2 pr-1.5" data-skill-run="running" data-onboarding="skill-status">
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
            {activeRun.phase === 'waiting-transcript'
              ? `${activeRun.skillName} · ${t('recording.panel.waitingForTranscription')}`
              : t('ask.skillRun.running', { name: activeRun.skillName })}
          </span>
        </button>
        <button
          type="button"
          onClick={activeRun.cancel}
          aria-label={t('ask.skillRun.stop', { name: activeRun.skillName })}
          title={t('ask.skillRun.stop', { name: activeRun.skillName })}
          className={DOCK_CTL_PRIMARY}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect width="12" height="12" x="6" y="6" rx="2.5" />
          </svg>
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
      {chip ? (
        <button
          type="button"
          title={chip.hint}
          data-dock-chip={chip.kind}
          onClick={chip.onClick}
          className={chip.kind === 'recording' ? DOCK_CHIP_ACCENT : DOCK_CHIP}
        >
          <span className={chip.kind === 'recording' ? DOCK_CHIP_ACCENT_BADGE : DOCK_CHIP_BADGE}>/</span>
          <span className="max-w-[110px] truncate">{chip.label}</span>
        </button>
      ) : null}
    </div>
  );
}
