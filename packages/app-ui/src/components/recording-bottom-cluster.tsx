'use client';

import * as React from 'react';
import { useQueryClient, useQueries } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useCurrentNote } from '../shell/current-note-context';
import { RECORDING_TROUBLESHOOTING_URL } from '../lib/docs-links';
import { recordingErrorHintKey } from '../lib/recording-error-help';
import { X } from 'lucide-react';
import { RecordingPillFace, recordingPillWidth } from './note-recording-dock';
import { DockUnit, DockRowmate } from './dock-unit';
import { SkillDockSlot } from './skill-sparkle-button';
import { getAutoEnhanceEnabled } from '@prismical/app-client';
import {
  consumePendingAutoTranscribe,
  getRecordingPreferences,
  useSyncStore,
} from '@prismical/app-client';
import { useTranslation } from 'react-i18next';
import {
  formatApplicationRelativeDay,
  formatApplicationTime,
  useApplicationLocale,
} from '@prismical/app-i18n';
import { useAutoEnhanceStore } from '@prismical/app-client';
import { useSkillDiffStore } from '@prismical/app-client';
import { NewNoteDock } from './new-note-dock';
import { AutoPausePrompt } from './auto-pause-prompt';
import { useRecordingDocumentTitle } from '../hooks/use-recording-document-title';
import { AnimatedWidth } from './animated-width';
import { TranscriptPanel, type RecordingLog } from './transcript-panel';
import { AskPillFace, ASK_PILL_WIDTH } from './ask/ask-dock-pill';
import type { ComposerSkill } from './ask/ask-composer';
import { useAskSkillRunStore } from '@prismical/app-client';
import { useSkillRunActive } from '@prismical/app-client';
import { useNavigation } from '@prismical/app-client';
import { AskPanel } from './ask/ask-panel';
import { useRecording } from '@prismical/app-client';
import { EVENTS, usePorts } from '@prismical/app-client';
import { listTranscriptSegments } from '@prismical/app-client';
import {
  useNoteRecordings,
  useEnhancedRecordings,
  segmentToLine,
  byTranscriptTime,
  transcriptKey,
  recordingsKey,
  noteRecordingsKey,
  enhancedRecordingsKey,
  speakersKey,
  listRecordingSpeakers,
  renameRecordingSpeaker,
  type TranscriptPresentationOptions,
} from '@prismical/app-client';

// No dedicated blur pre-warm component: the dock pills carry the same
// --surface-glass-filter as the panels and are visible from the app's first
// paint, so they compile the one blur shader config every glass surface uses
// (the cold first-use compile used to freeze the first panel open ~200ms).
// If a future layout ever ships glass panels WITHOUT the dock
// pills on screen, reintroduce an invisible warm-up speck there.

// Layout-level dock cluster: mounted once inside <SidebarInset> (which is
// `position: relative`) so it centres over the content area, pinned to the
// bottom. It MORPHS per page — on a note it shows the recording dock +
// transcription panel; on every other page it shows a "New note" pill. (Web-only
// divergence: desktop only shows the dock on a note.)
//
// One panel slot above the dock is SHARED between the transcription view and Ask AI: opening one
// collapses the other (they never stack). Both slots animate open/closed. Ask is available on every
// page; the transcript only on a note.
export function RecordingBottomCluster({
  compact = false,
  autoStartNoteId = null,
  onAutoStartConsumed,
}: {
  /**
   * Narrow-surface mode (the floating note): while a recording
   * is engaged the row hides the skill slot and the Ask pill — the recording
   * pill alone already fills the narrow window, and the full row would
   * overflow it. Idle keeps all three (they fit). Default false keeps the
   * web/app layout unchanged.
   */
  compact?: boolean;
  /**
   * Desktop-float autostart intent (the widget's Record): when it names the
   * current note, THIS cluster starts the recording through its OWN
   * useRecording instance. It must be this instance and not the float view's:
   * `error` is per-hook-instance state, so a start made elsewhere fails
   * invisibly — the dock's error pill never learns about it.
   */
  autoStartNoteId?: string | null;
  /** Ack the intent (one-shot) — called before the start is attempted. */
  onAutoStartConsumed?: () => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const { currentNote } = useCurrentNote();
  const qc = useQueryClient();
  // Product analytics via the injected AnalyticsPort.
  const { analytics, recording, env } = usePorts();
  const router = useNavigation();
  const syncStore = useSyncStore();

  // Which unit is expanded in place. Mutually exclusive by construction: expanding one
  // unit collapses the sibling out of the row entirely. Both panels stay MOUNTED through collapse
  // (the units crossfade faces), so the Ask conversation survives collapse/reopen within a page.
  const [expandedUnit, setExpandedUnit] = React.useState<'ask' | 'rec' | null>(null);
  // Per-unit maximize (the action cluster's expand toggle) — larger panel footprint, same morph.
  const [recMaxi, setRecMaxi] = React.useState(false);
  const [askMaxi, setAskMaxi] = React.useState(false);

  const rec = useRecording();

  // Session timer: shared by the pill, the panel bar and Ask's
  // recording-continues chip. Timestamp-DERIVED, not tick-accumulated: hidden
  // tabs throttle intervals to ~1/min, and a counter would silently undercount
  // a 30-minute meeting. `anchor` banks elapsed seconds across pauses; on a
  // rehydrated mid-session mount (desktop float window) it seeds from
  // rec.startedAt (wall clock — pause history isn't recoverable, best effort).
  // The value survives the stop (the done bar shows "Saved · t") and resets
  // when the NEXT session engages. ----
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  // `seeded` is an explicit flag, NOT inferred from baseSeconds===0 — a pause
  // banked within the first second leaves base at 0 and an inferred sentinel
  // would then re-seed from wall clock on resume, counting the whole pause.
  const timerAnchorRef = React.useRef<{
    baseSeconds: number;
    runningSince: number | null;
    seeded: boolean;
  }>({ baseSeconds: 0, runningSince: null, seeded: false });
  const recStartedAt = rec.startedAt;
  React.useEffect(() => {
    const anchor = timerAnchorRef.current;
    const seedFromWallClock = () =>
      recStartedAt ? Math.max(0, Math.round((Date.now() - Date.parse(recStartedAt)) / 1000)) : 0;
    if (rec.state === 'starting') {
      // New session engaging: reset (the previous session's value was held for
      // the "Saved · t" bar until now).
      timerAnchorRef.current = { baseSeconds: 0, runningSince: null, seeded: true };
      setElapsedSeconds(0);
      return;
    }
    if (rec.state === 'paused' && !anchor.seeded) {
      // Rehydrated into an already-paused session (desktop float window): seed
      // the display from wall clock (pause history isn't recoverable).
      timerAnchorRef.current = {
        baseSeconds: seedFromWallClock(),
        runningSince: null,
        seeded: true,
      };
      setElapsedSeconds(timerAnchorRef.current.baseSeconds);
      return;
    }
    if (rec.state === 'recording') {
      if (timerAnchorRef.current.runningSince === null) {
        const base = timerAnchorRef.current.seeded
          ? timerAnchorRef.current.baseSeconds
          : seedFromWallClock();
        timerAnchorRef.current = { baseSeconds: base, runningSince: Date.now(), seeded: true };
      }
      const tick = () => {
        const a = timerAnchorRef.current;
        setElapsedSeconds(
          a.baseSeconds +
            (a.runningSince !== null ? Math.round((Date.now() - a.runningSince) / 1000) : 0)
        );
      };
      tick();
      const id = setInterval(tick, 1000);
      return () => {
        clearInterval(id);
        // Leaving 'recording' (pause or stop): bank the run into baseSeconds.
        const a = timerAnchorRef.current;
        if (a.runningSince !== null) {
          timerAnchorRef.current = {
            baseSeconds: a.baseSeconds + Math.round((Date.now() - a.runningSince) / 1000),
            runningSince: null,
            seeded: true,
          };
        }
      };
    }
  }, [rec.state, recStartedAt]);

  // A live session, paused included: pausing must NOT hand the panel over to the persisted
  // rolling log (or re-enable its queries) — the live lines stay until the user stops.
  const sessionActive = rec.isRecording || rec.isPaused;
  // stop() flips state to "stopping" the instant it's called, but finalize + the persisted
  // refetch are still seconds away. Treat "stopping" as still-live so the persisted queries stay
  // parked (no partial-data refetch mid-stop) and the live lines keep showing.
  const liveActive = sessionActive || rec.state === 'stopping';
  const noteId = currentNote?.noteId ?? null;

  // Compact mode: from the first click ("starting") through "stopping" the
  // secondary pills leave the row entirely.
  const hideSecondary = compact && rec.state !== 'idle';
  // If Ask was open when a recording engaged, its pill just vanished — close
  // the panel too, or it would be stuck open with no toggle to dismiss it.
  React.useEffect(() => {
    if (hideSecondary) {
      setExpandedUnit(current => (current === 'ask' ? null : current));
    }
  }, [hideSecondary]);

  // Dead-mic capture (micSilent): the OS is feeding the browser pure silence — usually a
  // revoked/wedged system-level mic permission, which getUserMedia does NOT error on (the
  // tab happily "records" zeros). Without this the user only learns via an empty
  // transcript. Toast-only (the dock's red error pill is too subtle for something this
  // actionable); it stays up until dismissed, and the fix steps live in the docs.
  React.useEffect(() => {
    if (!rec.micSilent) return;
    // Standard sonner action button; the description stays short so the toast keeps
    // one-line height — the full fix steps live behind the button, in the docs.
    toast.warning(t('recording.errors.deadMicTitle'), {
      description: t('recording.errors.deadMicDescription'),
      duration: Infinity,
      closeButton: true,
      action: {
        label: t('recording.errors.deadMicHelp'),
        onClick: () =>
          window.open(
            'https://prismical.ai/docs/troubleshooting#recording-runs-but-nothing-is-transcribed',
            '_blank',
            'noopener'
          ),
      },
    });
  }, [rec.micSilent, t]);

  // ---- Auto-pause on silence ---------------------------------------------------------------
  // The grace prompt. Rendered as a custom toast so it can carry the notification-card anatomy
  // (amber bar, two-line content, actions right, countdown loader) rather than sonner's default
  // one-line shape — the desktop card and this must read as the same object.
  //
  // Note the INVERTED dismissal convention: sonner's onDismiss normally means "the user cancelled
  // whatever this was offering", but here dismissing means keep-recording, because any interaction
  // proves someone is present. Only an untouched countdown pauses, and that decision is made in
  // @prismical/silence off the sample clock — never by this toast's own timer, which is why the
  // toast itself is duration:Infinity and only ever closed by us.
  const graceToastRef = React.useRef<string | number | null>(null);
  const keepRecordingRef = React.useRef(rec.keepRecording);
  const pauseFromPromptRef = React.useRef(rec.pauseFromPrompt);
  React.useEffect(() => {
    keepRecordingRef.current = rec.keepRecording;
    pauseFromPromptRef.current = rec.pauseFromPrompt;
  }, [rec.keepRecording, rec.pauseFromPrompt]);

  const gracePrompt = rec.gracePrompt;
  const analyticsRef = React.useRef(analytics);
  React.useEffect(() => {
    analyticsRef.current = analytics;
  }, [analytics]);
  React.useEffect(() => {
    if (!gracePrompt) {
      if (graceToastRef.current !== null) {
        toast.dismiss(graceToastRef.current);
        graceToastRef.current = null;
      }
      return;
    }
    analyticsRef.current.capture(EVENTS.RECORDING_AUTO_PAUSE_PROMPTED, {
      recording_id: rec.recordingId,
      grace_ms: gracePrompt.graceMs,
    });
    const keep = (via: 'button' | 'dismiss') => {
      analyticsRef.current.capture(EVENTS.RECORDING_AUTO_PAUSE_KEPT, {
        recording_id: rec.recordingId,
        via,
      });
      keepRecordingRef.current();
    };
    // sonner fires onDismiss for a PROGRAMMATIC toast.dismiss too, not just a user gesture — so
    // without this flag our own withdrawal (speech returned, the pause committed, the session
    // stopped) would call keep(), suppress auto-pause for the rest of the session, and record a
    // phantom KEPT event.
    let withdrawnByMachine = false;
    const id = toast.custom(
      () => (
        <AutoPausePrompt
          graceMs={gracePrompt.graceMs}
          onKeepRecording={() => keep('button')}
          onPause={() => pauseFromPromptRef.current()}
        />
      ),
      {
        duration: Infinity,
        // Swipe/close = "I'm here" (see above), not "cancel the prompt and pause anyway".
        onDismiss: () => {
          if (withdrawnByMachine) return;
          keep('dismiss');
        },
      }
    );
    graceToastRef.current = id;
    return () => {
      withdrawnByMachine = true;
      toast.dismiss(id);
      if (graceToastRef.current === id) graceToastRef.current = null;
    };
    // rec.recordingId is read for the event payload only; re-running on it would tear the prompt
    // down and re-raise it (resetting the countdown animation) for a value that cannot change
    // mid-session anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gracePrompt]);

  // The pause landed and it was OUR decision, not a button the user pressed — say so, and keep it
  // up until they act. The user is by definition away, so a few-second toast is a toast nobody
  // sees. Suppressed when the dead-mic warning is already up: that one is more actionable and
  // explains the same silence better.
  const autoPaused = rec.isPaused && rec.pauseReason === 'silence';
  const micSilent = rec.micSilent;
  const resumeRef = React.useRef(rec.resume);
  React.useEffect(() => {
    resumeRef.current = rec.resume;
  }, [rec.resume]);
  React.useEffect(() => {
    if (!autoPaused) return;
    analyticsRef.current.capture(EVENTS.RECORDING_AUTO_PAUSED, { recording_id: rec.recordingId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPaused]);
  React.useEffect(() => {
    if (!autoPaused || micSilent) return;
    const id = toast(t('recording.autoPause.pausedTitle'), {
      description: t('recording.autoPause.nothingLost'),
      duration: Infinity,
      closeButton: true,
      action: {
        label: t('recording.actions.resume'),
        onClick: () => void resumeRef.current(),
      },
    });
    return () => {
      toast.dismiss(id);
    };
  }, [autoPaused, micSilent, t]);

  const requestAutoEnhance = useAutoEnhanceStore(s => s.requestAutoEnhance);

  // The note's recordings (newest first) + which are already folded in — drives the rolling log,
  // the "N recordings" picker, and each row's wand vs "in note" state. The noteId stays in the
  // query key during a live recording (only fetching pauses) so the cached logs survive the
  // start/stop flips — nulling the key used to empty the panel and flash it back after finalize.
  const recordings = useNoteRecordings(noteId, { enabled: !liveActive });
  const folded = useEnhancedRecordings(noteId, { enabled: !liveActive });
  const recs = recordings.data ?? [];

  const transcriptPresentation = React.useMemo<TranscriptPresentationOptions>(
    () => ({
      locale: resolvedLocale,
      speakerLabels: {
        you: t('recording.panel.you'),
        them: t('recording.panel.them'),
        speaker: t('recording.panel.speaker'),
        speakerNumber: number => t('recording.panel.speakerNumber', { number }),
      },
    }),
    [resolvedLocale, t]
  );

  const startedLabels = React.useCallback(
    (startedAt: string | null): { day: string; time: string } => {
      const date = startedAt ? new Date(startedAt) : null;
      if (!date || Number.isNaN(date.getTime())) return { day: '', time: '' };
      return {
        day: formatApplicationRelativeDay(date, new Date(), resolvedLocale, t),
        time: formatApplicationTime(date, resolvedLocale),
      };
    },
    [resolvedLocale, t]
  );

  // One transcript query per recording so the panel can show a single rolling log across all of
  // them. Chronological = startTimeMs because finalize rows use a reserved
  // segmentOrder space that is not chronological.
  const transcriptQueries = useQueries({
    queries: recs.map(r => ({
      queryKey: [...transcriptKey(r.id), resolvedLocale],
      enabled: !liveActive,
      queryFn: async () =>
        (await listTranscriptSegments(r.id))
          .sort(byTranscriptTime)
          .map(s => segmentToLine(s, r.startedAt, undefined, transcriptPresentation)),
    })),
  });

  // The speaker registry per recording — labels, colors, rename targets.
  const speakerQueries = useQueries({
    queries: recs.map(r => ({
      queryKey: speakersKey(r.id),
      enabled: !liveActive,
      queryFn: () => listRecordingSpeakers(r.id),
    })),
  });

  // The finalize lifecycle from recording.meta (written server-side by the drain): 'identifying'
  // = staged audio exists but the diarized pass hasn't settled — the panel shows its state and
  // we poll below until it does. Bounded by stagedAt age: a drain that never runs (engine
  // unconfigured, dead scheduler) must not leave an eternal spinner + 4s poll.
  const finalizePhase = (r: (typeof recs)[number]): string | null => {
    const meta = (r.meta ?? {}) as {
      staging?: { status?: string; stagedAt?: string };
      finalize?: { status?: string };
    };
    // Everything below is bounded by age: an in-progress finalize status OR
    // staged audio older than the window means the pipeline died (upload never
    // completed, dead scheduler) — surface "settled" rather than pinning the
    // panel's post-stop bar (and the 4s poll) on an eternal spinner. The bound
    // reads stagedAt when present, else the recording's own start time.
    const anchorTs = Date.parse(meta.staging?.stagedAt ?? r.startedAt ?? '');
    const fresh = Number.isFinite(anchorTs) && Date.now() - anchorTs < 30 * 60_000;
    if (['awaiting_upload', 'pending', 'running'].includes(meta.finalize?.status ?? '')) {
      return fresh ? 'identifying' : null;
    }
    if (meta.finalize?.status) return meta.finalize.status;
    if (meta.staging?.status === 'staged') {
      return fresh ? 'identifying' : null;
    }
    return null;
  };

  // RecordingLog[] (newest first): the picker order. `number` is chronological (oldest = 1).
  const recordingLogs: RecordingLog[] = recs.map((r, i) => ({
    id: r.id,
    number: recs.length - i,
    ...startedLabels(r.startedAt),
    durationMs: r.durationMs,
    lines: transcriptQueries[i]?.data ?? [],
    folded: folded.data?.has(r.id) ?? false,
    speakers: speakerQueries[i]?.data,
    identifyingSpeakers: finalizePhase(r) === 'identifying',
  }));

  // While any recording is being diarized, poll the whole surface (recordings → meta flips,
  // then segments + speakers) so the labels settle without a manual refresh. Two triggers:
  // a recording already showing 'identifying', OR a bounded post-stop settle window — staging
  // completes AFTER stop() resolves (fire-and-forget upload), so without the window the meta
  // flip is invisible (staleTime 30s, no focus refetch) and the lifecycle would never start.
  const anyIdentifying = recs.some(r => finalizePhase(r) === 'identifying');
  const [settleUntil, setSettleUntil] = React.useState<number | null>(null);
  const finishedRecordingId = rec.recordingId;
  // The just-finished session, WITH a timestamp: rec.recordingId survives for the
  // whole SPA session, but the panel's Saved→Ready bar sequence must only run for
  // a recording that stopped moments ago — not re-play hours later when the user
  // revisits the note (the panel remounts per noteId).
  const [recentlyFinished, setRecentlyFinished] = React.useState<{
    id: string;
    at: number;
  } | null>(null);
  React.useEffect(() => {
    if (!sessionActive && finishedRecordingId) {
      setSettleUntil(Date.now() + 120_000);
      setRecentlyFinished({ id: finishedRecordingId, at: Date.now() });
    }
  }, [sessionActive, finishedRecordingId]);
  // The interval reads FRESH recs through a ref: the effect deliberately doesn't re-run per
  // fetch, and a stale closure would skip recordings that became 'identifying' later.
  const recsRef = React.useRef(recs);
  recsRef.current = recs;
  const shouldPoll = (anyIdentifying || settleUntil !== null) && !!noteId && !liveActive;
  React.useEffect(() => {
    if (!shouldPoll || !noteId) return;
    const interval = setInterval(() => {
      if (settleUntil !== null && Date.now() > settleUntil) setSettleUntil(null);
      void qc.invalidateQueries({ queryKey: noteRecordingsKey(noteId) });
      for (const r of recsRef.current) {
        if (finalizePhase(r) === 'identifying') {
          void qc.invalidateQueries({ queryKey: transcriptKey(r.id) });
          void qc.invalidateQueries({ queryKey: speakersKey(r.id) });
        }
      }
    }, 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fresh recs come via recsRef; keying on the flags + note is the intent
  }, [shouldPoll, settleUntil, noteId]);

  // The settle only becomes visible when the TURN queries refetch, and the poll above skips them
  // once a recording is no longer 'identifying'. Keying the refresh to the phase TRANSITION
  // ensures persisted results replace the live rows and also covers passes fast enough to never be observed as
  // 'identifying' at all (the eager drain can finish between two 4s ticks).
  const phaseSig = recs.map(r => `${r.id}:${finalizePhase(r) ?? ''}`).join('|');
  const prevPhasesRef = React.useRef<Map<string, string | null>>(new Map());
  React.useEffect(() => {
    const prev = prevPhasesRef.current;
    const next = new Map<string, string | null>();
    for (const r of recs) {
      const phase = finalizePhase(r);
      next.set(r.id, phase);
      // First sight of a recording is not a transition — only refresh on an observed change.
      if (prev.has(r.id) && prev.get(r.id) !== phase) {
        void qc.invalidateQueries({ queryKey: transcriptKey(r.id) });
        void qc.invalidateQueries({ queryKey: speakersKey(r.id) });
      }
    }
    prevPhasesRef.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recs identity churns per fetch; phaseSig captures exactly the transitions we act on
  }, [phaseSig]);

  // Rename a diarized speaker, then refresh every speaker registry (the id → recording mapping
  // is server-side; the prefix invalidation is cheap and correct).
  const onRenameSpeaker = (speakerId: string, displayName: string | null) => {
    void renameRecordingSpeaker(speakerId, displayName)
      .then(() => qc.invalidateQueries({ queryKey: ['recording-speakers'] }))
      .catch(() => toast.error(t('recording.errors.renameSpeaker')));
  };

  // The per-recording wand: enhance THAT recording. Routed through the same request store the
  // auto-enhance uses, so it runs via the dock (Generating/Stop) and stages a diff to review.
  const onEnhanceRecording = (recordingId: string) => {
    if (!noteId) return;
    // The dock consumes the request via the run button, which is hidden while a diff is staged — so
    // don't queue onto an unreviewed suggestion (it would linger and fire at a confusing moment).
    if (useSkillDiffStore.getState().candidatesByNote.has(noteId)) {
      toast.info(t('recording.errors.currentSuggestion'));
      return;
    }
    requestAutoEnhance({ noteId, recordingId });
  };

  const isAskOpen = expandedUnit === 'ask';
  const isTranscriptionOpen = expandedUnit === 'rec';

  // A staged skill diff lives in the ROW (the diff bar / review surface), and the
  // note body underneath is what's being reviewed — collapse whichever panel is
  // open so both are actually visible. Also covers auto-enhance right after a
  // stop, which stages while the record panel is still expanded.
  const hasStagedCandidate = useSkillDiffStore(s =>
    noteId ? s.candidatesByNote.has(noteId) : false
  );
  // A run in flight on this note (any lane: sparkle-engine, ask-slash,
  // auto-enhance, inline) — the skill slot enters the row to show
  // Generating/Stop while it lasts.
  const skillRunActive = useSkillRunActive(noteId ?? '');
  React.useEffect(() => {
    if (hasStagedCandidate) setExpandedUnit(null);
  }, [hasStagedCandidate]);

  // Escape collapses whichever unit is expanded. The global keydown handler and
  // the composer's Escape-when-menus-closed both land here. Layered
  // UI that owns Escape — Radix menus/popovers, the composer's slash/@ menus —
  // closes itself AND preventDefaults, so only an unclaimed Escape reaches
  // this. Listener registered only while a unit is actually expanded.
  const hasExpanded = expandedUnit !== null;
  React.useEffect(() => {
    if (!hasExpanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      setExpandedUnit(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hasExpanded]);

  // A collapse always resets both panels to their normal footprint so reopening
  // a panel does not unexpectedly restore a maximized state.
  React.useEffect(() => {
    if (expandedUnit !== null) return;
    setRecMaxi(false);
    setAskMaxi(false);
  }, [expandedUnit]);

  // Ask composer `/skill` sends: route through the same
  // bridge lane as auto-enhance so the run shows the dock's Generating/Stop and
  // stages a diff; the panel collapses so the staged diff (and its bar) are
  // visible over the note.
  const onAskRunSkill = React.useMemo(() => {
    if (!currentNote) return undefined;
    const targetNoteId = currentNote.noteId;
    return (skill: ComposerSkill, instruction: string) => {
      if (useSkillDiffStore.getState().candidatesByNote.has(targetNoteId)) {
        toast.info(t('recording.errors.currentSuggestion'));
        return;
      }
      useAskSkillRunStore.getState().requestAskSkillRun({
        noteId: targetNoteId,
        skillId: skill.id,
        skillName: skill.name,
        instruction: instruction || undefined,
      });
      setExpandedUnit(null);
    };
  }, [currentNote, t]);

  // The collapsed pill's suggested-skill chip is ONE CLICK — it runs the skill
  // immediately with no guidance.
  // The run engine's presentation takes over from there: the Generating/Stop
  // pill slides into the row, then the staged diff's Keep/Undo review pill.
  const onPickSuggestedSkill = React.useMemo(() => {
    if (!onAskRunSkill) return undefined;
    return (skill: ComposerSkill) => onAskRunSkill(skill, '');
  }, [onAskRunSkill]);

  const toggleTranscription = () => setExpandedUnit(p => (p === 'rec' ? null : 'rec'));

  // Reset transient, note-scoped panel state whenever the note in view changes (incl. leaving a
  // note entirely — noteId becomes null). The transcript gives up the slot; Ask keeps it.
  const stopRef = React.useRef(rec.stop);
  stopRef.current = rec.stop;
  // The note the live session is bound to — a retained snapshot (id + title). A recording is bound to
  // the note it started on, but it must SURVIVE navigating off that note to a non-note page (Settings,
  // Home, People, …): it keeps capturing in the background, and the dock shows a "Recording · <title>"
  // pill with FULL controls (pause·wave·timer·stop) that can also expand its panel. Only switching to a *different* note stops it;
  // noteId→null (off-note) and returning to the same note do not. Seeded when the session goes live,
  // kept fresh while on the recording's own note (title edits), cleared when it ends. `sessionNoteIdRef`
  // mirrors the id for the synchronous stop-gate below (a ref avoids a stale-closure read on noteId change).
  const [recordingNote, setRecordingNote] = React.useState<{
    noteId: string;
    title: string;
  } | null>(null);
  const sessionNoteIdRef = React.useRef<string | null>(null);
  /** Set right before the stop-triggered navigation back to the recording's note. */
  const autoNavNoteIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!liveActive) {
      sessionNoteIdRef.current = null;
      setRecordingNote(null);
      return;
    }
    if (sessionNoteIdRef.current === null && currentNote) {
      sessionNoteIdRef.current = currentNote.noteId;
    }
    if (currentNote && currentNote.noteId === sessionNoteIdRef.current) {
      setRecordingNote({ noteId: currentNote.noteId, title: currentNote.title });
    }
  }, [liveActive, currentNote]);

  // The tab title carries the session for anyone who has tabbed away. Reads
  // off `recordingNote` rather than `currentNote` so it keeps naming the RECORDING's note after
  // the user navigates elsewhere, which is precisely when the signal earns its keep.
  useRecordingDocumentTitle({
    active: liveActive,
    paused: rec.isPaused,
    noteTitle: recordingNote?.title ?? null,
  });

  React.useEffect(() => {
    // Arriving via the auto-navigate-on-stop path: keep the record panel open so
    // the Saved → Ready sequence plays on the note itself, instead of
    // the usual note-change reset.
    if (autoNavNoteIdRef.current !== null && autoNavNoteIdRef.current === noteId) {
      // Deliberately NOT clearing the auto-enhance / ask-slash stores here:
      // any parked request was queued by the stop that navigated us HERE and
      // belongs to this very note.
      autoNavNoteIdRef.current = null;
      setRecMaxi(false);
      setExpandedUnit('rec');
      return;
    }
    setRecMaxi(false);
    setRecentlyFinished(null);
    setExpandedUnit(p => (p === 'rec' ? null : p));
    // Stop only when moving to a DIFFERENT note mid-session — never when leaving to a non-note page
    // (noteId null) or returning to the recording's own note, so background recording persists.
    if (
      sessionNoteIdRef.current !== null &&
      noteId !== null &&
      noteId !== sessionNoteIdRef.current
    ) {
      void stopRef.current();
    }
    // Drop any auto-enhance or ask-slash request that never got consumed (e.g.
    // navigated away before the dock ran it) so it can't fire against the wrong
    // note or re-fire on return.
    useAutoEnhanceStore.getState().clear();
    useAskSkillRunStore.getState().clear();
  }, [noteId]);

  // Live session lines while recording (the rolling log takes over once stopped).
  const liveLines = rec.liveSegments.map(s =>
    segmentToLine(s, rec.startedAt, undefined, transcriptPresentation)
  );

  // Bridge the stop handover: after stop() the finished recording's persisted
  // transcript isn't in the rolling log until finalize + a two-hop refetch (recordings list →
  // per-recording segments) lands. Without a bridge the panel leaves the live branch immediately
  // and shows empty/stale content for that whole window, so the transcript vanishes and flashes
  // back. The live segments already hold the complete transcript and survive until the next
  // start(), so keep rendering them until the finished recording actually surfaces in the log.
  const finishedId = rec.recordingId;
  const persistedHasFinished =
    !!finishedId && recordingLogs.some(r => r.id === finishedId && r.lines.length > 0);
  // The bridge is BOUNDED by the settle window: if the persisted transcript never
  // lands (offline after stop, genuinely empty recording), the panel must fall
  // back to the persisted log + idle bar rather than pinning "Finishing up…"
  // forever — the bar is the only Start affordance.
  const showLiveTranscript =
    liveActive ||
    (!!finishedId && liveLines.length > 0 && !persistedHasFinished && settleUntil !== null);
  // True once the session has ended but we're still bridging on live lines (finalize + refetch in
  // flight) — the footer says "Finishing up…" rather than a misleading "Listening…".
  const isFinishing = showLiveTranscript && !sessionActive;

  // Web-only auto-start. Wait for the optimistic note's server echo before
  // creating its recording, or the recording can race the note foreign key.
  const currentNoteRef = React.useRef(currentNote);
  currentNoteRef.current = currentNote;
  const startRef = React.useRef(rec.start);
  startRef.current = rec.start;

  // Desktop-float autostart (see the prop doc): consume the intent once and
  // start through THIS instance so a failure surfaces in THIS dock's error
  // pill/banner instead of dying in the float view's separate hook instance.
  React.useEffect(() => {
    if (!autoStartNoteId || !currentNote || currentNote.noteId !== autoStartNoteId) return;
    if (rec.state !== 'idle') {
      onAutoStartConsumed?.();
      return;
    }
    onAutoStartConsumed?.();
    void startRef.current(currentNote.noteId, currentNote.title);
    // Same reveal as the manual and web-auto start lanes: the live transcript
    // is the point of starting.
    setExpandedUnit('rec');
    analyticsRef.current.capture(EVENTS.RECORDING_STARTED, {
      note_id: currentNote.noteId,
      automatic: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartNoteId, currentNote?.noteId, rec.state]);
  React.useEffect(() => {
    if (
      recording.control ||
      !syncStore ||
      !noteId ||
      rec.state !== 'idle' ||
      !consumePendingAutoTranscribe(noteId)
    ) {
      return;
    }

    let cancelled = false;
    void syncStore
      .whenNoteCreateAcked(noteId)
      .then(() => {
        const note = currentNoteRef.current;
        if (
          cancelled ||
          note?.noteId !== noteId ||
          !getRecordingPreferences().autoTranscribeNewNotes
        ) {
          return;
        }
        void startRef.current(note.noteId, note.title);
        setExpandedUnit('rec');
        analyticsRef.current.capture(EVENTS.RECORDING_STARTED, {
          note_id: note.noteId,
          automatic: true,
        });
      })
      .catch(() => {
        if (!cancelled) {
          toast.error(t('recording.errors.autoStartTitle'), {
            description: t('recording.errors.autoStartDescription'),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [noteId, rec.state, recording.control, syncStore, t]);

  const onStart = () => {
    if (!currentNote) return;
    void rec.start(currentNote.noteId, currentNote.title || t('recording.untitledRecording'));
    setExpandedUnit('rec');
    analytics.capture(EVENTS.RECORDING_STARTED, { note_id: currentNote.noteId });
  };
  // Both captures gate on the resolved outcome: a guard-rejected double-click or a failed
  // resume must not inflate the pause/resume counts.
  const onPause = () => {
    const props = { note_id: currentNote?.noteId ?? null, recording_id: rec.recordingId };
    void rec.pause().then(ok => {
      if (ok) analytics.capture(EVENTS.RECORDING_PAUSED, props);
    });
  };
  const onResume = () => {
    const props = { note_id: currentNote?.noteId ?? null, recording_id: rec.recordingId };
    void rec.resume().then(ok => {
      if (ok) analytics.capture(EVENTS.RECORDING_RESUMED, props);
    });
  };
  const onStop = (opts?: { returnToNote?: boolean }) => {
    const finishedId = rec.recordingId;
    const note = currentNote;
    // The note this session belongs to — the CURRENT note, or (stopped while
    // away) the recording's own note. Cache invalidations and auto-enhance key
    // on it, so a stop behaves the same wherever it was pressed.
    const targetNoteId = note?.noteId ?? recordingNote?.noteId ?? null;
    // Stopped away from the recording's note via a USER gesture: bring the user
    // back to it (the transcript + done sequence live there) with the record
    // panel open. An unattended auto-stop must never hijack navigation.
    const returnTo =
      (opts?.returnToNote ?? true) && !note && recordingNote ? recordingNote.noteId : null;
    void rec.stop().then(({ segments }) => {
      if (returnTo) {
        autoNavNoteIdRef.current = returnTo;
        router.push(`/notes/${returnTo}`);
      }
      analytics.capture(EVENTS.RECORDING_COMPLETED, {
        note_id: targetNoteId,
        recording_id: finishedId,
        segments,
      });
      // Pull the now-persisted transcript + recording lists for the finished session. Both the latest
      // (recordingsKey) AND the picker (noteRecordingsKey) lists need it — they're separate query keys,
      // and the picker one is disabled during recording, so it won't otherwise show the new recording
      // until its staleTime lapses. Folded state can shift too (re-enhance).
      if (finishedId) void qc.invalidateQueries({ queryKey: transcriptKey(finishedId) });
      if (targetNoteId) {
        void qc.invalidateQueries({ queryKey: recordingsKey(targetNoteId) });
        void qc.invalidateQueries({ queryKey: noteRecordingsKey(targetNoteId) });
        void qc.invalidateQueries({ queryKey: enhancedRecordingsKey(targetNoteId) });
      }

      // Auto-enhance the just-stopped recording: queue even when the live lane
      // produced zero segments — deferred finalization creates the first transcript, and the
      // server readiness gate holds this run until that pass settles.
      if (!finishedId || !targetNoteId || !getAutoEnhanceEnabled()) return;
      // Don't stack onto an unreviewed diff — if a candidate is already staged the dock won't run
      // anyway (it shows the diff bar, not the run button). Skip so the request can't linger.
      if (useSkillDiffStore.getState().candidatesByNote.has(targetNoteId)) return;
      requestAutoEnhance({ noteId: targetNoteId, recordingId: finishedId });
    });
  };

  // Auto-stop: the hook detects the deadline, but the stop runs through the SAME
  // handler the dock's stop button uses — so an abandoned session still gets its completed
  // analytics, its four cache invalidations and its auto-enhance, and the user comes back to a
  // finished note rather than a bare transcript.
  const onStopRef = React.useRef(onStop);
  React.useEffect(() => {
    onStopRef.current = onStop;
  });
  React.useEffect(() => {
    if (!rec.autoStopRequested) return;
    analyticsRef.current.capture(EVENTS.RECORDING_AUTO_STOPPED, { recording_id: rec.recordingId });
    onStopRef.current({ returnToNote: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.autoStopRequested]);

  // Panel footprints: the unit morphs to these when expanded. The inner max()
  // keeps a usable panel on desktop; below 820px the `--dock-panel-w` custom
  // property (set by tokens.css on `.dock-narrow-panels`) overrides every
  // desktop expression with the full-bleed calc(100vw - 24px) — a var()
  // read inside the inline style is the one thing a media query CAN reach.
  // Compact (the floating note window): panels take the FULL window width and
  // a shorter height; compact widths skip the var deliberately.
  const recPanelWidth = compact
    ? 'calc(100vw - 16px)'
    : recMaxi
      ? 'var(--dock-panel-w, min(760px, max(280px, 100vw - 290px)))'
      : 'var(--dock-panel-w, min(500px, max(280px, 100vw - 320px)))';
  const askPanelWidth = compact
    ? 'calc(100vw - 16px)'
    : askMaxi
      ? 'var(--dock-panel-w, min(820px, max(280px, 100vw - 290px)))'
      : 'var(--dock-panel-w, min(620px, max(280px, 100vw - 320px)))';
  // Compact normal heights differ per unit and are svh-capped so a short
  // window still fits.
  const panelHeight = (maxi: boolean, unit: 'rec' | 'ask') =>
    compact
      ? maxi
        ? 'min(560px, 86svh)'
        : unit === 'rec'
          ? 'min(380px, 70svh)'
          : 'min(400px, 70svh)'
      : maxi
        ? 'min(660px, 84svh)'
        : 'min(440px, 66svh)';

  // The rec panel shows its own error banner while expanded — the floating pill
  // is the collapsed-dock notice (anchored to the dock baseline, NOT the row,
  // whose height is the expanded panel's).
  const showErrorPill = Boolean(rec.error && currentNote) && !isTranscriptionOpen;
  // Known-cause errors carry their concrete fix (e.g. the mic-permission path
  // for this platform) next to the generic troubleshooting link.
  const recErrorHint = React.useMemo(() => {
    if (!rec.error) return null;
    const key = recordingErrorHintKey(rec.error, env.getEnv().platform);
    return key ? t(key) : null;
  }, [rec.error, env, t]);

  return (
    <div
      className={`dock-narrow-panels pointer-events-none absolute inset-x-0 z-40 ${compact ? 'bottom-[10px]' : 'bottom-4'}`}
    >
      {/* Error notice for the COLLAPSED dock (rec.error persists until the next
          start; note-scoped so a stale mic error never floats over other pages).
          Anchored just above the 42px dock baseline regardless of any expanded
          panel's height. transition-[opacity,translate]: Tailwind v4's
          translate-y-* is the NATIVE translate property. */}
      <div
        role={showErrorPill ? 'alert' : undefined}
        aria-hidden={!showErrorPill}
        // inset-x + mx-auto + w-fit, NOT left-1/2/-translate-x-1/2: an abs-pos
        // box with left:50% and auto width only gets HALF the container as its
        // shrink-to-fit budget, which wrapped this pill into a tall sliver on
        // narrow surfaces (the float window).
        className={`absolute inset-x-3 bottom-[54px] z-50 mx-auto w-fit max-w-[480px] rounded-[10px] border border-destructive/25 bg-[color-mix(in_srgb,var(--destructive)_12%,var(--dock-surface))] px-3.5 py-1.5 text-center text-[12.5px] font-medium text-[color-mix(in_srgb,var(--destructive)_65%,var(--dock-ink))] shadow-(--dock-shadow) transition-[opacity,translate] duration-200 ease-out ${
          showErrorPill
            ? 'pointer-events-auto translate-y-0 opacity-100'
            : 'pointer-events-none translate-y-1 opacity-0'
        }`}
      >
        {/* Text renders ONLY while the pill is actually shown: an always-mounted copy
            would double every error string with the panel banner (and read as visible
            to the a11y tree / test tooling even at opacity 0). */}
        {showErrorPill && rec.error ? (
          <span className="flex flex-col items-center gap-0.5">
            <span className="inline-flex items-center gap-1">
              <span>{t(rec.error)}</span>
              <button
                type="button"
                onClick={rec.clearError}
                aria-label={t('common.actions.close')}
                className="-mr-1.5 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            </span>
            <span className="text-[12px] font-normal opacity-90">
              {recErrorHint ? <>{recErrorHint} </> : null}
              <a
                href={RECORDING_TROUBLESHOOTING_URL}
                target="_blank"
                rel="noreferrer"
                className="whitespace-nowrap underline underline-offset-2"
              >
                {t('recording.errors.troubleshoot')}
              </a>
            </span>
          </span>
        ) : null}
      </div>
      <div
        className={`mx-auto flex w-full max-w-4xl flex-col items-center ${compact ? 'px-[10px]' : 'px-6'}`}
      >
        {/* Dock row (v3): two morphing units — Record and Ask — that expand IN PLACE into
            their panels (the sibling collapses out of the row), plus the transient skill
            slot. items-end so an expanding unit grows upward off the shared baseline; the
            row sits bottom-anchored, so panel growth pushes up, never down. The left slot
            still morphs per page (recording unit on a note, away/new-note pill elsewhere)
            inside an AnimatedWidth so navigation slides the dock to its new size instead
            of snapping it — the skill slot rides INSIDE that wrapper so the
            page morph slides the combined width rather than popping the skill pill. */}
        <div
          className={`pointer-events-auto relative flex items-end ${compact ? 'gap-1.5' : 'gap-2'}`}
        >
          <AnimatedWidth
            contentKey={
              currentNote ? 'note' : liveActive && recordingNote ? 'recording-away' : 'list'
            }
          >
            {currentNote ? (
              <div className="flex items-end gap-2">
                <DockUnit
                  compact={compact}
                  expanded={isTranscriptionOpen}
                  collapsed={isAskOpen}
                  pillWidth={recordingPillWidth(rec.state, rec.canPause, compact)}
                  panelWidth={recPanelWidth}
                  panelHeight={panelHeight(recMaxi, 'rec')}
                  pill={
                    <RecordingPillFace
                      recState={rec.state}
                      canPause={rec.canPause}
                      isPanelOpen={isTranscriptionOpen}
                      onTogglePanel={toggleTranscription}
                      onStopRecording={onStop}
                      onPauseRecording={onPause}
                      onResumeRecording={onResume}
                      elapsedSeconds={elapsedSeconds}
                    />
                  }
                  panel={
                    <TranscriptPanel
                      key={currentNote.noteId}
                      isRecording={showLiveTranscript}
                      isPaused={rec.isPaused}
                      pauseReason={rec.pauseReason}
                      isFinishing={isFinishing}
                      liveLines={liveLines}
                      recordings={recordingLogs}
                      onEnhanceRecording={onEnhanceRecording}
                      onRenameSpeaker={onRenameSpeaker}
                      isExpanded={recMaxi}
                      onToggleExpanded={() => setRecMaxi(v => !v)}
                      onClose={() => setExpandedUnit(null)}
                      recState={rec.state}
                      canPause={rec.canPause}
                      elapsedSeconds={elapsedSeconds}
                      onStartRecording={onStart}
                      onStopRecording={onStop}
                      onPauseRecording={onPause}
                      onResumeRecording={onResume}
                      errorText={isTranscriptionOpen && rec.error ? t(rec.error) : null}
                      errorHint={isTranscriptionOpen ? recErrorHint : null}
                      onDismissError={rec.clearError}
                      finishedRecordingId={
                        !sessionActive &&
                        recentlyFinished &&
                        Date.now() - recentlyFinished.at < 10 * 60_000
                          ? recentlyFinished.id
                          : null
                      }
                    />
                  }
                />
                {/* Skill run pill / diff bar — kept mounted while a recording is engaged.
                    The dock has exactly TWO units; skills live inside Ask (slash
                    tokens + the suggested chip). The slot stays MOUNTED (it hosts the run
                    engine consuming the auto-enhance / ask-slash / inline bridges) but only
                    ENTERS the row while it has something to show: a run in flight (the
                    Generating/Stop pill) or a staged candidate (the Keep/Undo review pill,
                    which replaces the collapsed Ask pill). */}
                {
                  <DockRowmate
                    collapsed={expandedUnit !== null || !(hasStagedCandidate || skillRunActive)}
                  >
                    <div
                      className={rec.state !== 'idle' ? 'dock-slot-dimmed pointer-events-none' : ''}
                      {...(rec.state !== 'idle' ? { inert: true } : {})}
                      aria-hidden={rec.state !== 'idle'}
                    >
                      <SkillDockSlot compact={compact} />
                    </div>
                  </DockRowmate>
                }
              </div>
            ) : liveActive && recordingNote ? (
              // Off the recording's note: the SAME live pill with full
              // controls — pause · wave · timer · stop — and the panel still
              // expands on the live transcript, with a "Go to note" jump in its
              // bar. Only the note-scoped extras (history, enhance) are absent.
              <DockUnit
                compact={compact}
                expanded={isTranscriptionOpen}
                collapsed={isAskOpen}
                pillWidth={recordingPillWidth(rec.state, rec.canPause, compact)}
                panelWidth={recPanelWidth}
                panelHeight={panelHeight(recMaxi, 'rec')}
                pill={
                  <RecordingPillFace
                    recState={rec.state}
                    canPause={rec.canPause}
                    isPanelOpen={isTranscriptionOpen}
                    onTogglePanel={toggleTranscription}
                    onStopRecording={onStop}
                    onPauseRecording={onPause}
                    onResumeRecording={onResume}
                    elapsedSeconds={elapsedSeconds}
                  />
                }
                panel={
                  <TranscriptPanel
                    key={`away-${recordingNote.noteId}`}
                    isRecording={showLiveTranscript}
                    isPaused={rec.isPaused}
                    pauseReason={rec.pauseReason}
                    isFinishing={isFinishing}
                    liveLines={liveLines}
                    recordings={[]}
                    onEnhanceRecording={() => {}}
                    isExpanded={recMaxi}
                    onToggleExpanded={() => setRecMaxi(v => !v)}
                    onClose={() => setExpandedUnit(null)}
                    recState={rec.state}
                    canPause={rec.canPause}
                    elapsedSeconds={elapsedSeconds}
                    onStartRecording={() => {}}
                    onStopRecording={onStop}
                    onPauseRecording={onPause}
                    onResumeRecording={onResume}
                    errorText={isTranscriptionOpen && rec.error ? t(rec.error) : null}
                    errorHint={isTranscriptionOpen ? recErrorHint : null}
                    onDismissError={rec.clearError}
                    onOpenNote={() => router.push(`/notes/${recordingNote.noteId}`)}
                  />
                }
              />
            ) : (
              <DockRowmate collapsed={isAskOpen}>
                <NewNoteDock />
              </DockRowmate>
            )}
          </AnimatedWidth>
          {!hideSecondary && (
            <DockUnit
              compact={compact}
              expanded={isAskOpen}
              // A staged skill diff hands the Ask slot to the review pill (the
              // diff bar in the skill slot): the Ask pill becomes the
              // review pill while an edit is under review.
              collapsed={isTranscriptionOpen || hasStagedCandidate}
              // Compact (the floating note window): the full composer-width pill would
              // overflow the narrow window, so it shrinks to an icon-and-hint stub.
              pillWidth={
                compact
                  ? 'min(300px, calc(100vw - 90px))'
                  : `min(${ASK_PILL_WIDTH}px, calc(100vw - 106px))`
              }
              panelWidth={askPanelWidth}
              panelHeight={panelHeight(askMaxi, 'ask')}
              pill={
                <AskPillFace
                  onClick={() => setExpandedUnit('ask')}
                  onPickSkill={onPickSuggestedSkill}
                  noteId={noteId}
                  runActive={skillRunActive}
                />
              }
              panel={
                <AskPanel
                  open={isAskOpen}
                  isMaximized={askMaxi}
                  onToggleMaximized={() => setAskMaxi(v => !v)}
                  onClose={() => setExpandedUnit(null)}
                  recordingActive={sessionActive}
                  recordingPaused={rec.isPaused}
                  recordingSeconds={elapsedSeconds}
                  onShowRecording={currentNote ? () => setExpandedUnit('rec') : undefined}
                  onRunSkill={onAskRunSkill}
                  compact={compact}
                />
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
