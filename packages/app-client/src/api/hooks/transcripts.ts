'use client';

import { useQuery } from '@tanstack/react-query';
import {
  listNoteRecordings,
  listRecordingSpeakers,
  listTranscriptSegments,
  type CoreTranscriptSegment,
} from '../transcription';
import { listEnhancedRecordingIds } from './skill-runs';
import { useSyncStore } from '../../sync/provider';
import type { TranscriptLine } from '@prismical/app-contracts';
// Clock-time formatter lives in the data layer (event-time.ts) so this hook can
// use it without importing app-ui (which would be circular); app-ui re-exports it.
import { formatTime12 } from '../../event-time';

export const recordingsKey = (noteId: string) => ['recordings', noteId] as const;
export const transcriptKey = (recordingId: string) => ['transcript', recordingId] as const;
export const noteRecordingsKey = (noteId: string) => ['note-recordings', noteId] as const;
export const enhancedRecordingsKey = (noteId: string) => ['enhanced-recordings', noteId] as const;

/** Offset from the recording's start, e.g. "03:07". */
export function formatTimestampMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * A segment's wall-clock time in the viewer's zone, e.g. "9:41 AM". Segment times are
 * offsets from the recording's start, so an absolute clock needs the recording's `startedAt` — when
 * that's missing (nullable column) we fall back to the raw offset rather than inventing a time.
 */
export function segmentClockLabel(
  startedAt: string | null,
  startTimeMs: number,
  locale = 'en-US'
): string {
  const started = startedAt ? new Date(startedAt) : null;
  if (!started || Number.isNaN(started.getTime())) return formatTimestampMs(startTimeMs);
  return formatTime12(new Date(started.getTime() + Math.max(0, startTimeMs)), locale);
}

export interface TranscriptSpeakerLabels {
  you: string;
  them: string;
  speaker: string;
  speakerNumber: (number: number) => string;
}

export interface TranscriptPresentationOptions {
  locale?: string;
  speakerLabels?: TranscriptSpeakerLabels;
}

const englishSpeakerLabels: TranscriptSpeakerLabels = {
  you: 'You',
  them: 'Them',
  speaker: 'Speaker',
  speakerNumber: number => `Speaker ${number}`,
};

/**
 * Display label for a speaker key, through the registry when available:
 * rename wins; 'you' stays "You"; diarized keys derive "Speaker N"; 'them' and anything
 * unknown keep the legacy "Them".
 */
export function speakerLabel(
  key: string,
  names?: Map<string, string | null>,
  labels: TranscriptSpeakerLabels = englishSpeakerLabels
): string {
  const named = names?.get(key);
  if (named) return named;
  if (key === 'you') return labels.you;
  if (key.startsWith('dz:')) {
    const n = Number(key.slice(3));
    return Number.isFinite(n) ? labels.speakerNumber(n + 1) : labels.speaker;
  }
  return labels.them;
}

/** `startedAt` is the segment's parent recording's — pass it explicitly (never bare `.map(segmentToLine)`). */
export function segmentToLine(
  seg: CoreTranscriptSegment,
  startedAt: string | null,
  names?: Map<string, string | null>,
  presentation?: TranscriptPresentationOptions
): TranscriptLine {
  return {
    id: seg.id,
    speaker: speakerLabel(seg.speaker, names, presentation?.speakerLabels),
    speakerKey: seg.speaker,
    at: segmentClockLabel(startedAt, seg.startTimeMs, presentation?.locale),
    text: seg.text,
  };
}

/** Latest recording for a note (by startedAt, falling back to epoch for nulls). */
export function useLatestNoteRecording(noteId: string | null) {
  return useQuery({
    queryKey: recordingsKey(noteId ?? 'none'),
    enabled: !!noteId,
    queryFn: async () => {
      const recs = await listNoteRecordings(noteId!);
      if (!recs.length) return null;
      return [...recs].sort(
        (a, b) => new Date(b.startedAt ?? 0).getTime() - new Date(a.startedAt ?? 0).getTime()
      )[0];
    },
  });
}

/** All recordings for a note, newest first — the transcription-window picker.
 * `opts.enabled` suppresses FETCHING without changing the query key, so cached data stays
 * mounted (e.g. during a live recording) instead of flashing empty under a "none" key. */
export function useNoteRecordings(noteId: string | null, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: noteRecordingsKey(noteId ?? 'none'),
    enabled: !!noteId && (opts?.enabled ?? true),
    queryFn: async () => {
      const recs = await listNoteRecordings(noteId!);
      return [...recs].sort(
        (a, b) => new Date(b.startedAt ?? 0).getTime() - new Date(a.startedAt ?? 0).getTime()
      );
    },
  });
}

/** The set of a note's recordings already folded in via Enhance — drives the wand vs "in note" state
 * of each recording in the picker. `opts.enabled` as in useNoteRecordings. */
export function useEnhancedRecordings(noteId: string | null, opts?: { enabled?: boolean }) {
  const store = useSyncStore();
  return useQuery({
    queryKey: enhancedRecordingsKey(noteId ?? 'none'),
    enabled: !!noteId && (opts?.enabled ?? true),
    queryFn: async ({ signal }) => {
      // Optimistic notes render before their metadata exists on the server. History
      // requires read access, so wait for the same create acknowledgement as collaboration.
      await store?.whenNoteCreateAcked(noteId!);
      // Navigation or an identity reset may cancel the query while the create is pending.
      signal.throwIfAborted();
      return new Set(await listEnhancedRecordingIds(noteId!));
    },
  });
}

/** Chronological transcript order: finalize-pass rows live in a reserved
 * segmentOrder space far above live rows, so segmentOrder no longer means chronology —
 * startTimeMs does, with segmentOrder as the stable tiebreak. */
export function byTranscriptTime(
  a: Pick<CoreTranscriptSegment, 'startTimeMs' | 'segmentOrder'>,
  b: Pick<CoreTranscriptSegment, 'startTimeMs' | 'segmentOrder'>
): number {
  return a.startTimeMs - b.startTimeMs || a.segmentOrder - b.segmentOrder;
}

/** Persisted transcript for a recording, as panel-ready lines (chronological). `startedAt`
 * is the recording's, and anchors each line's wall-clock time. */
export function useTranscriptSegments(
  recordingId: string | null,
  startedAt: string | null,
  presentation?: TranscriptPresentationOptions
) {
  return useQuery({
    queryKey: [...transcriptKey(recordingId ?? 'none'), presentation?.locale ?? 'en-US'],
    enabled: !!recordingId,
    queryFn: async () => {
      const segs = await listTranscriptSegments(recordingId!);
      return segs
        .sort(byTranscriptTime)
        .map(s => segmentToLine(s, startedAt, undefined, presentation));
    },
  });
}

export const speakersKey = (recordingId: string) => ['recording-speakers', recordingId] as const;

/** The speaker registry for a recording — rename map and avatar identities. */
export function useRecordingSpeakers(recordingId: string | null, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: speakersKey(recordingId ?? 'none'),
    enabled: !!recordingId && (opts?.enabled ?? true),
    queryFn: () => listRecordingSpeakers(recordingId!),
  });
}

/** Only needed by empty-body notes; never sends note content to an AI provider. */
export function useTitleTranscriptAvailable(noteId: string, enabled: boolean) {
  const { data: recordings = [] } = useNoteRecordings(noteId, { enabled });
  const readyIds = recordings.filter(r => r.status === 'completed').map(r => r.id);
  return useQuery({
    // Keyed on the SET of ready recordings rather than spread as separate members, so the key is
    // stable under list reordering. Note what this does NOT do: the set still changes when a
    // recording completes, so that still mints a new key and still re-downloads every transcript
    // on the note. Only per-recording keys would fix that, and they need the shared raw-segments
    // cache described below. The saving realised here is the staleTime.
    queryKey: ['title-transcript-available', noteId, [...readyIds].sort().join(',')],
    enabled: enabled && readyIds.length > 0,
    // Was 5s, six times more aggressive than the app default, on the most expensive query we have
    // (each call is an unbounded full-column segment list per recording). Nothing invalidates this
    // key, so the cost of the default is a slightly later unlock of "Name with AI" on a note whose
    // transcript is still landing — worth it against re-downloading every transcript on the note.
    staleTime: 30_000,
    queryFn: async () => {
      const segments = await Promise.all(readyIds.map(id => listTranscriptSegments(id)));
      return segments.some(rows => rows.some(segment => segment.isFinal && segment.text.trim()));
    },
  });
}
