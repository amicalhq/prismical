import type { ApplicationTFunction } from '@prismical/app-i18n';

/** The shape both dock chips need from a recording row. */
export interface PendingRecordingCandidate {
  id: string;
  /** Already folded into the note via a kept Enhance. */
  folded: boolean;
  lines: readonly unknown[];
  /** Audio upload or transcript processing is still pending. */
  processing?: boolean;
}

/**
 * The newest recording whose transcript is ready and has not been folded into the note yet —
 * the one the dock offers to turn into notes. Older unfolded recordings stay reachable from the
 * history list; only the newest earns a chip. `recordings` is NEWEST first.
 */
export function pendingRecording<T extends PendingRecordingCandidate>(
  recordings: readonly T[]
): T | null {
  const latest = recordings[0];
  if (!latest) return null;
  if (latest.folded || latest.processing || latest.lines.length === 0) return null;
  return latest;
}

export interface RecordingSkillCopy {
  /** Chip label: "Generate notes" on an empty note, "Enhance notes" once the note has text. */
  label: string;
  /** Tooltip / accessible description saying what the run does to THIS note. */
  hint: string;
}

/**
 * State-aware copy for the recording→note action. The skill is Enhance either way; the label
 * says what will happen to the user's note: written from scratch, or filled in around what they
 * typed while recording. `noteBodyEmpty` is false when unknown (no editor mounted), which keeps the
 * conservative "Enhance" wording.
 */
export function recordingSkillCopy(
  noteBodyEmpty: boolean,
  t: ApplicationTFunction
): RecordingSkillCopy {
  return noteBodyEmpty
    ? { label: t('recording.skill.generateLabel'), hint: t('recording.skill.generateHint') }
    : { label: t('recording.skill.enhanceLabel'), hint: t('recording.skill.enhanceHint') };
}
