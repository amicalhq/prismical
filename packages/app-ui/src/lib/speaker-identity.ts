import type { TranscriptLine } from '@prismical/app-contracts';

/** The registry fields identity resolution reads; the full row carries more. */
export interface SpeakerIdentityRow {
  speakerKey: string;
  isOwner?: boolean;
  source?: string;
}

/**
 * Is this speaker the recording owner?
 *
 * - `you` is the mic channel, the owner by construction - unless the user explicitly said
 *   "Not me" on it (a `user`-sourced row with the flag off), which covers a guest speaking
 *   alone into the owner's laptop.
 * - Any other key is the owner only when its registry row carries the flag (set by
 *   "This is me", or later by an attribution pass).
 */
export function isOwnerSpeaker(
  key: string,
  registry?: { get(key: string): SpeakerIdentityRow | undefined } | null
): boolean {
  const row = registry?.get(key);
  if (key === 'you') return !(row && row.source === 'user' && row.isOwner === false);
  return row?.isOwner === true;
}

/** The registry fields label resolution reads. */
export interface SpeakerLabelRow extends SpeakerIdentityRow {
  displayName?: string | null;
}

/** The recording owner as the viewer sees them. */
export interface OwnerView {
  isViewer: boolean;
  name: string | null;
}

/** Translated fallbacks the resolver needs. */
export interface SpeakerLabelStrings {
  you: string;
  them: string;
  owner: string;
}

/**
 * The one rule for a speaker's label, shared by the bubbles and copy/export: the owner reads
 * "You" to the viewer-owner and the owner's name (registry name first) to anyone else; every
 * other speaker reads its registry name, else the derived label the line arrived with, else
 * "Them" for an un-owned mic channel.
 */
export function resolveSpeakerLabel(
  key: string | undefined,
  derived: string,
  registry: { get(key: string): SpeakerLabelRow | undefined } | null | undefined,
  owner: OwnerView | null | undefined,
  strings: SpeakerLabelStrings
): string {
  if (!key) return derived;
  const entry = registry?.get(key);
  if (isOwnerSpeaker(key, registry)) {
    if (!owner || owner.isViewer) return strings.you;
    return entry?.displayName ?? owner.name ?? strings.owner;
  }
  return entry?.displayName ?? (key === 'you' ? strings.them : derived);
}

/**
 * Should the transcript ask "Which one is you?" - two or more numbered speakers and not one
 * line whose speaker is the owner (a mic-lane pass replaced the owner channel, or the user
 * said "Not me" on it). Cheap and derived from what the panel already holds.
 */
export function needsOwnerChoice(
  lines: readonly TranscriptLine[],
  speakers?: readonly SpeakerIdentityRow[] | null
): boolean {
  const registry = new Map((speakers ?? []).map(s => [s.speakerKey, s]));
  const numbered = new Set(lines.map(l => l.speakerKey).filter(k => k?.startsWith('dz:')));
  return (
    numbered.size >= 2 &&
    !lines.some(l => l.speakerKey !== undefined && isOwnerSpeaker(l.speakerKey, registry))
  );
}
