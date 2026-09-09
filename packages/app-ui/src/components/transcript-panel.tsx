'use client';
import { useWalkthroughStage } from '../onboarding/context';

import * as React from 'react';
import {
  AudioLines,
  Check,
  Copy,
  Eye,
  FileText,
  History,
  Loader2,
  Pause,
  Play,
  Search,
  User,
  Wand2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from '../ui/message-scroller';
import { Marker, MarkerContent, MarkerIcon } from '../ui/marker';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { formatApplicationDuration, useApplicationLocale } from '@prismical/app-i18n';
import { RECORDING_TROUBLESHOOTING_URL } from '../lib/docs-links';
import { copyToClipboard } from '../lib/clipboard';
import { DockPanelAction, DockPanelActions } from './dock-panel-actions';
import { DockMicMenu } from './dock-mic-menu';
import { PxOrbitLoader } from './px-orbit-loader';
import { Waveform } from './waveform';
import { DOCK_CTL, DOCK_SCROLL_BUTTON } from './dock-chrome';
import { formatSessionTimer } from './note-recording-dock';
import { Avatar, AvatarFallback } from '../ui/avatar';
import { UserAvatar } from '../ui/user-avatar';
import { useAutoEnhanceStore, useSessionView, useViewerProfile } from '@prismical/app-client';
import type { RecState } from '@prismical/app-client';
import type { TranscriptLine } from '@prismical/app-contracts';
import { useTranslation } from 'react-i18next';

/** One registry entry for a recording's speaker — drives labels + rename. */
export interface RecordingSpeakerInfo {
  id: string;
  speakerKey: string; // 'you' | 'them' | 'dz:N'
  displayName: string | null;
}

// One recording's contribution to the rolling log + its picker metadata.
export interface RecordingLog {
  id: string;
  /** Display number, chronological (oldest = 1). */
  number: number;
  /** The day it started, relative to now: "Today" / "3 days ago" ("" if it has no startedAt). */
  day: string;
  /** The clock time it started, in the viewer's zone: "9:41 AM" ("" if it has no startedAt). */
  time: string;
  durationMs: number | null;
  lines: TranscriptLine[];
  /** `lines` reflects the server (the transcript query settled), not a pending fetch's []. */
  linesLoaded?: boolean;
  /** Already folded into the note via a kept Enhance. */
  folded: boolean;
  /** Speaker registry rows, once the finalize pass has minted them. */
  speakers?: RecordingSpeakerInfo[];
  /** Audio upload or transcript processing is still pending. */
  processing?: boolean;
  /** The settled finalize outcome from recording.meta ('done' | 'failed' | 'skipped' | 'stalled'
   * for a pass that aged out unfinished), null while unknown. Drives the post-stop bar's final
   * line: a failed or stalled pass is not "Transcript ready". */
  finalizeStatus?: string | null;
}

type TranscriptPanelProps = {
  /** Mid-session (recording OR paused, or the post-stop bridge): live lines, live footer. */
  isRecording?: boolean;
  /** Session paused. Only meaningful while isRecording. */
  isPaused?: boolean;
  /** Why it paused — drives copy only. */
  pauseReason?: 'user' | 'silence' | null;
  /** Session ended but persisted lines haven't landed — "Finishing up…". */
  isFinishing?: boolean;
  /** Live lines for the in-progress recording. */
  liveLines: TranscriptLine[];
  /** Identifies the live recording so its persisted row is not rendered twice. */
  activeRecordingId?: string | null;
  /** Note-scoped skill activity, separate from capture/finalization controls. */
  skillStatus?: (fallback: React.ReactNode, hideCompleted: boolean) => React.ReactNode;
  /** All of the note's recordings, NEWEST first. */
  recordings: RecordingLog[];
  /** Enhance THAT recording into the note. */
  /** `auto` = the bar re-firing a parked auto-enhance; stays on the on-stop lane (no Ask pop). */
  onEnhanceRecording: (recordingId: string, opts?: { auto?: boolean }) => void;
  /** Rename a diarized speaker; absent ⇒ labels are not editable. */
  onRenameSpeaker?: (speakerId: string, displayName: string | null) => void;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onClose: () => void;
  // The panel owns the full recording controls.
  recState: RecState;
  canPause?: boolean;
  /** Cluster-owned session seconds (timestamp-derived; survives stop for "Saved · t"). */
  elapsedSeconds: number;
  onStartRecording: () => void;
  startBlockedReason?: string;
  hideStartRecording?: boolean;
  onStopRecording: () => void;
  onPauseRecording?: () => void;
  onResumeRecording?: () => void;
  /** Translated recording error, shown as an in-panel banner just above the bar. */
  errorText?: string | null;
  /** Concrete per-error fix (e.g. the platform's mic-permission path), shown
   * before the docs link. Null when the cause has no specific remedy. */
  errorHint?: string | null;
  /** The server's first recovery action for the error (e.g. "Open AI models"), as a link. */
  errorAction?: { label: string; onClick: () => void } | null;
  /** Dismiss the surfaced error (the banner's X). */
  onDismissError?: () => void;
  /** Off the recording's note, the live bar offers a jump back. */
  onOpenNote?: () => void;
  recordingNoteTitle?: string;
  /** The just-finished session's recording id — drives the Saved → Transcribing →
   * Identifying → Ready bar sequence after a stop. */
  finishedRecordingId?: string | null;
};

/** Registry-resolved labels (renames win) — line.speaker was derived at fetch time. */
function linesToText(lines: TranscriptLine[], speakers?: RecordingSpeakerInfo[]): string {
  const names = new Map((speakers ?? []).map(s => [s.speakerKey, s.displayName]));
  return lines
    .map(l => `${(l.speakerKey && names.get(l.speakerKey)) || l.speaker}: ${l.text}`)
    .join('\n');
}

/**
 * The Record unit's panel content: ONE continuous message-style log
 * across every recording (subtle labeled divider where each begins), a bottom
 * bar that carries the full recording controls for the current state (start /
 * pause·wave·timer·stop / finishing / saved-transcribing-ready), and the
 * hover-revealed action cluster (history menu · copy · maximize · collapse).
 */
export function TranscriptPanel(props: TranscriptPanelProps) {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <TranscriptPanelContent {...props} />
    </MessageScrollerProvider>
  );
}

function TranscriptPanelContent({
  isRecording = false,
  isPaused = false,
  pauseReason = null,
  isFinishing = false,
  liveLines,
  activeRecordingId = null,
  skillStatus,
  recordings,
  onEnhanceRecording,
  onRenameSpeaker,
  isExpanded,
  onToggleExpanded,
  onClose,
  recState,
  canPause = false,
  elapsedSeconds,
  onStartRecording,
  startBlockedReason,
  hideStartRecording = false,
  onStopRecording,
  onPauseRecording,
  onResumeRecording,
  errorText = null,
  errorHint = null,
  errorAction = null,
  onDismissError,
  onOpenNote,
  recordingNoteTitle,
  finishedRecordingId = null,
}: TranscriptPanelProps) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const { scrollToMessage } = useMessageScroller();
  const [histOpen, setHistOpen] = React.useState(false);
  const [histQuery, setHistQuery] = React.useState('');

  // "You" turns show the signed-in user's own avatar.
  const sessionView = useSessionView();
  const me = sessionView.accounts.find(a => a.sub === sessionView.activeSub);
  const viewer = {
    name: me?.name ?? null,
    email: me?.email ?? null,
    image: useViewerProfile().data?.image ?? null,
  };

  // Rolling log renders OLDEST first; the history menu lists NEWEST first (as given).
  const chronological = React.useMemo(() => [...recordings].reverse(), [recordings]);
  const hasAnyPersisted = recordings.some(r => r.lines.length > 0);

  const scrollToRecording = (id: string) => {
    setHistOpen(false);
    requestAnimationFrame(() => {
      scrollToMessage(`recording-${id}`, { behavior: 'smooth', align: 'start' });
    });
  };

  const copyRecording = async (rec: RecordingLog) => {
    setHistOpen(false);
    if (await copyToClipboard(linesToText(rec.lines, rec.speakers))) {
      toast.success(t('recording.panel.copied', { number: rec.number }));
    } else {
      toast.error(t('recording.panel.copyBlocked'));
    }
  };

  // Cluster copy: the WHOLE rolling log, oldest first, blocks separated.
  const copyAll = async () => {
    const text = chronological
      .filter(r => r.lines.length > 0)
      .map(r => linesToText(r.lines, r.speakers))
      .join('\n\n');
    if (!text) return;
    if (await copyToClipboard(text)) toast.success(t('recording.actions.copyTranscript'));
    else toast.error(t('recording.panel.copyBlocked'));
  };

  // Post-stop bar sequence: Saved → Transcribing… → Identifying speakers… →
  // Transcript ready + Enhance chip. Driven off the finished
  // recording's REAL finalize state (processing from recording.meta),
  // not timers; only the final "ready" hold auto-dismisses back to the idle bar. ----
  const finished = finishedRecordingId
    ? recordings.find(r => r.id === finishedRecordingId)
    : undefined;
  const tour = useWalkthroughStage();
  const keepTourTranscript = !!tour && ['transcript', 'enhance'].includes(tour.step);
  const [doneDismissed, setDoneDismissed] = React.useState(false);
  React.useEffect(() => {
    if (keepTourTranscript) setDoneDismissed(false);
  }, [keepTourTranscript]);
  React.useEffect(() => setDoneDismissed(false), [finishedRecordingId]);
  const doneReady = !!finished && !finished.processing;
  // What the settled bar says. A diarization pass that FAILED still leaves the live transcript
  // (labels are what's missing); a failed pass on a recording with no lines means there is
  // no transcript at all. 'skipped' is not a failure, and an empty `lines` only counts once the
  // transcript query has actually answered - right after stop it is still pending.
  const doneOutcome: 'ready' | 'noSpeakers' | 'noTranscript' = !finished
    ? 'ready'
    : finished.finalizeStatus === 'failed' || finished.finalizeStatus === 'stalled'
      ? finished.lines.length === 0
        ? finished.linesLoaded
          ? 'noTranscript'
          : 'ready'
        : finished.finalizeStatus === 'failed'
          ? 'noSpeakers'
          : 'ready'
      : 'ready';
  // A failed Enhance (auto-on-stop or the chip) must not leave the recording stranded: the chip is
  // its only retry affordance, and both the click and the hold below dismiss the bar that carries
  // it. Bring the bar back, and hold it — an error is exactly the case the timer must not eat.
  // The hold is escapable: while it stands the bar carries an explicit close, which consumes the
  // marker so the effect below can't re-open what the user just dismissed.
  const failedRecordingId = useAutoEnhanceStore(s => s.failedRecordingId);
  const clearFailedRecording = useAutoEnhanceStore(s => s.clearFailed);
  const enhanceFailed = !!finished && failedRecordingId === finished.id;
  // A PARKED Enhance (the server kept saying "still finalizing" past its own deadline) is not an
  // error: hold the bar open saying so, and re-fire the run by itself the moment the recording's
  // finalize phase settles. The chip stays as the manual way to do the same.
  const waitingRecordingId = useAutoEnhanceStore(s => s.waitingRecordingId);
  const clearWaitingRecording = useAutoEnhanceStore(s => s.clearWaiting);
  const enhanceWaiting = !!finished && waitingRecordingId === finished.id;
  const holdOpen = enhanceFailed || enhanceWaiting;
  React.useEffect(() => {
    if (holdOpen) setDoneDismissed(false);
  }, [holdOpen]);
  React.useEffect(() => {
    if (!doneReady || doneDismissed || holdOpen || keepTourTranscript) return;
    const id = setTimeout(() => setDoneDismissed(true), 8000);
    return () => clearTimeout(id);
  }, [doneReady, doneDismissed, holdOpen, keepTourTranscript]);
  // At most ONE automatic re-fire per recording. The phase helper reports a recording as settled
  // after a wall-clock cutoff even when the server row is still blocking, and a re-fired run that
  // parks again would flip `enhanceWaiting` back on with `doneReady` still true — without this
  // guard that is an unbounded request loop. The marker is NOT cleared here: `requestAutoEnhance`
  // clears it only when the run is actually queued (the chip handler refuses while an unreviewed
  // suggestion exists), so a refused re-fire leaves the bar holding the chip for the user.
  const autoRefiredRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    if (!enhanceWaiting || !doneReady || !finished) return;
    if (autoRefiredRef.current.has(finished.id)) return;
    autoRefiredRef.current.add(finished.id);
    onEnhanceRecording(finished.id, { auto: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once on the settle transition
  }, [enhanceWaiting, doneReady]);
  const settledEmpty = doneReady && !!finished?.linesLoaded && finished.lines.length === 0 &&
    finished.finalizeStatus !== 'failed' && finished.finalizeStatus !== 'stalled';
  const doneMode = !isRecording && recState === 'idle' && !!finished && !doneDismissed &&
    !settledEmpty && !startBlockedReason;

  // The refetch gap right after a stop with no live-line bridge (short/silent
  // recordings): the finished recording isn't in `recordings` yet, so without
  // this the bar would flash the idle Start branch and then snap to "Saved…".
  // Bounded (2 min) so a recording that never surfaces can't pin the bar.
  const [settleExpired, setSettleExpired] = React.useState(false);
  React.useEffect(() => {
    setSettleExpired(false);
    if (!finishedRecordingId) return;
    const id = setTimeout(() => setSettleExpired(true), 120_000);
    return () => clearTimeout(id);
  }, [finishedRecordingId]);
  const settling =
    !isRecording && recState === 'idle' && !!finishedRecordingId && !finished && !settleExpired;

  const engaged = recState !== 'idle';
  const live = recState === 'recording';
  // Always use the timer format (for example, "Saved · 42:18"); the prose duration
  // ("42 minutes") clashed with the m:ss timers everywhere else in the bar.
  const savedDuration = finished?.durationMs
    ? formatSessionTimer(Math.max(Math.round(finished.durationMs / 1000), 1))
    : formatSessionTimer(Math.max(elapsedSeconds, 1));

  const filteredHistory = recordings.filter(r => {
    const q = histQuery.trim().toLowerCase();
    if (!q) return true;
    return `${t('recording.panel.recordingNumber', { number: r.number })} ${r.day} ${r.time}`
      .toLowerCase()
      .includes(q);
  });

  // Background transcript/skill work must not take away the next capture action.
  const enhanceAction =
    doneMode && finished ? (
      doneReady && !finished.folded && finished.lines.length > 0 ? (
        <button
          type="button"
          data-onboarding="enhance"
          onClick={() => {
            setDoneDismissed(true);
            onEnhanceRecording(finished.id);
          }}
          className="flex h-7 items-center gap-1.5 rounded-lg bg-dock-field px-2 pl-1 text-xs font-medium text-dock-ink transition-colors hover:bg-dock-hover"
        >
          <span className="flex size-[18px] items-center justify-center rounded-[5px] bg-dock-surface text-[11px] font-semibold text-dock-ink-2">
            /
          </span>
          {t('recording.panel.enhanceChip')}
        </button>
      ) : null
    ) : null;

  return (
    <div data-onboarding="transcript" className="relative flex h-full w-full flex-col">
      <DockPanelActions
        isMaximized={isExpanded}
        onToggleMaximized={onToggleExpanded}
        collapseLabel={t('recording.actions.hideTranscription')}
        onCollapse={onClose}
      >
        {/* Past recordings — a fixed-width from-top menu with hover row-actions. */}
        <Popover
          open={histOpen}
          onOpenChange={o => {
            setHistOpen(o);
            if (!o) setHistQuery('');
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              className={DOCK_CTL}
              aria-label={t('recording.actions.pastRecordings')}
            >
              <History className="size-[15px]" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="bottom"
            align="end"
            sideOffset={6}
            className="w-[308px] rounded-[10px] border-dock-line bg-dock-surface p-1 shadow-(--dock-shadow-raised)"
          >
            <div className="mx-0.5 mb-1 flex h-7 items-center gap-1.5 rounded-[7px] bg-dock-field px-2">
              <Search className="size-[13px] text-dock-ink-3" />
              <input
                value={histQuery}
                onChange={e => setHistQuery(e.target.value)}
                placeholder={t('recording.actions.pastRecordings')}
                className="min-w-0 flex-1 bg-transparent text-[12.5px] text-dock-ink outline-none placeholder:text-dock-ink-3"
              />
            </div>
            {filteredHistory.length === 0 ? (
              <div className="px-2 py-2 text-xs text-dock-ink-3">{t('recording.panel.empty')}</div>
            ) : (
              filteredHistory.map(rec => (
                <div
                  key={rec.id}
                  className="group/row flex h-[34px] w-full items-center gap-2 rounded-md px-2 hover:bg-dock-hover"
                >
                  <AudioLines className="size-[13px] shrink-0 text-dock-ink-2" />
                  <button
                    type="button"
                    onClick={() => scrollToRecording(rec.id)}
                    className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
                  >
                    <span className="shrink-0 whitespace-nowrap text-[12.5px] font-medium text-dock-ink">
                      {t('recording.panel.recordingNumber', { number: rec.number })}
                    </span>
                    <span className="min-w-0 truncate text-xs text-dock-ink-3">
                      {[rec.day, rec.time].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                  <span className="shrink-0 text-xs tabular-nums text-dock-ink-3 group-hover/row:hidden">
                    {formatApplicationDuration(rec.durationMs, resolvedLocale, t)}
                  </span>
                  <span className="hidden shrink-0 items-center gap-0.5 group-hover/row:flex">
                    <MiniAction
                      label={t('recording.actions.copyTranscript')}
                      onClick={() => void copyRecording(rec)}
                    >
                      <Copy className="size-3" />
                    </MiniAction>
                    <MiniAction
                      label={t('recording.actions.viewInLog')}
                      onClick={() => scrollToRecording(rec.id)}
                    >
                      <Eye className="size-3.5" />
                    </MiniAction>
                    {!rec.folded && rec.lines.length > 0 && (
                      <MiniAction
                        label={
                          rec.processing
                            ? t('recording.panel.waitingFinal')
                            : t('recording.actions.addToNote')
                        }
                        disabled={rec.processing}
                        onClick={() => {
                          setHistOpen(false);
                          onEnhanceRecording(rec.id);
                        }}
                      >
                        <Wand2 className="size-3.5" />
                      </MiniAction>
                    )}
                  </span>
                </div>
              ))
            )}
          </PopoverContent>
        </Popover>
        <DockPanelAction
          label={t('recording.actions.copyTranscript')}
          onClick={() => void copyAll()}
        >
          <Copy className="size-[14px]" />
        </DockPanelAction>
      </DockPanelActions>

      {/* Body — one rolling log across all recordings, message-bubble style. */}
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport aria-label={t('recording.panel.log')}>
          <MessageScrollerContent className="gap-0">
            {chronological
              .filter(rec => !isRecording || rec.id !== activeRecordingId)
              .map(rec => (
                <MessageScrollerItem
                  key={rec.id}
                  className="px-3.5 pb-3.5 first:pt-2"
                  messageId={`recording-${rec.id}`}
                >
                  {/* Divider with a centered-left label: which recording, which day. */}
                  <div className="mb-3 mt-1 flex items-center gap-2">
                    <span className="flex-1 border-t border-dock-line" />
                    <span className="whitespace-nowrap text-2xs font-semibold uppercase tracking-wide text-dock-ink-3">
                      {[
                        t('recording.panel.recordingNumber', { number: rec.number }),
                        [rec.day, rec.time].filter(Boolean).join(', '),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    <span className="flex-1 border-t border-dock-line" />
                  </div>
                  {rec.processing ? (
                    <Marker className="mb-3 w-auto" role="status">
                      <MarkerIcon>
                        <Loader2 className="animate-spin" />
                      </MarkerIcon>
                      <MarkerContent className="shimmer shimmer-duration-1400 text-dock-ink-3 text-2xs font-medium">
                        {rec.lines.length === 0
                          ? t('recording.panel.transcribing')
                          : t('recording.panel.identifyingSpeakers')}
                      </MarkerContent>
                    </Marker>
                  ) : null}
                  <TranscriptBubbles
                    lines={rec.lines}
                    viewer={viewer}
                    speakers={rec.speakers}
                    onRenameSpeaker={onRenameSpeaker}
                  />
                </MessageScrollerItem>
              ))}
            {isRecording ? (
              <MessageScrollerItem className="p-3.5" messageId="live-recording">
                <div className="mb-3 mt-1 flex items-center gap-2">
                  <span className="flex-1 border-t border-dock-line" />
                  <span
                    className="min-w-0 truncate text-2xs font-semibold uppercase tracking-wide text-dock-ink-3"
                    title={recordingNoteTitle}
                  >
                    {onOpenNote
                      ? (recordingNoteTitle ?? t('recording.panel.title'))
                      : t('recording.panel.recordingNumber', {
                          number:
                            recordings.find(rec => rec.id === activeRecordingId)?.number ??
                            Math.max(0, ...recordings.map(rec => rec.number)) + 1,
                        })}
                  </span>
                  <span className="flex-1 border-t border-dock-line" />
                </div>
                <TranscriptBubbles lines={liveLines} viewer={viewer} live />
                {isFinishing || !isPaused ? (
                  <Marker className="mt-2 w-auto" role="status">
                    <MarkerIcon>
                      <Loader2 className="animate-spin" />
                    </MarkerIcon>
                    <MarkerContent className="shimmer shimmer-duration-1400 text-dock-ink-3 font-medium">
                      {t(
                        isFinishing
                          ? 'recording.panel.finishing'
                          : liveLines.length === 0
                            ? 'recording.panel.listeningInitial'
                            : 'recording.panel.listening'
                      )}
                    </MarkerContent>
                  </Marker>
                ) : null}
                {isPaused && !isFinishing ? (
                  <Marker className="mt-2 w-auto" role="status">
                    <MarkerIcon>
                      <Pause />
                    </MarkerIcon>
                    <MarkerContent className="font-medium">
                      {pauseReason === 'silence'
                        ? t('recording.panel.pausedNoSound')
                        : t('recording.panel.paused')}
                    </MarkerContent>
                  </Marker>
                ) : null}
              </MessageScrollerItem>
            ) : recState === 'stopping' || isFinishing || settling ? (
              <MessageScrollerItem className="p-3.5" messageId="finishing-recording">
                <Marker className="w-auto" role="status">
                  <MarkerIcon>
                    <Loader2 className="animate-spin" />
                  </MarkerIcon>
                  <MarkerContent className="shimmer shimmer-duration-1400 text-dock-ink-3 font-medium">
                    {t('recording.panel.finishing')}
                  </MarkerContent>
                </Marker>
              </MessageScrollerItem>
            ) : !hasAnyPersisted && !recordings.some(rec => rec.processing) ? (
              <MessageScrollerItem className="flex min-h-full flex-1">
                <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-dock-ink-3">
                  {t('recording.panel.empty')}
                </div>
              </MessageScrollerItem>
            ) : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        {/* Dock-token styling and right alignment; the app default is centered
            on app tokens. */}
        <MessageScrollerButton className={DOCK_SCROLL_BUTTON} />
      </MessageScroller>

      {/* In-panel error banner, pinned just above the control bar. An expanded
          panel shows its own errors; the pill notice is for the
          collapsed dock). */}
      {errorText ? (
        <div
          role="alert"
          className="absolute inset-x-0 bottom-[41px] z-20 flex items-start gap-2 border-t border-dock-line bg-[color-mix(in_srgb,var(--destructive)_12%,var(--dock-surface))] px-3.5 py-2 text-[12.5px] font-medium text-[color-mix(in_srgb,var(--destructive)_65%,var(--dock-ink))]"
        >
          <span className="min-w-0 flex-1">
            {errorText}
            <span className="mt-0.5 block text-[12px] font-normal opacity-90">
              {errorHint ? <>{errorHint} </> : null}
              {errorAction ? (
                <button
                  type="button"
                  onClick={errorAction.onClick}
                  className="mr-1 whitespace-nowrap underline underline-offset-2"
                >
                  {errorAction.label}
                </button>
              ) : null}
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
          {onDismissError ? (
            <button
              type="button"
              onClick={onDismissError}
              aria-label={t('common.actions.close')}
              className="-mr-1 mt-0.5 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Bottom bar — the panel's full recording controls; 42px rhythm. */}
      <div className="flex min-h-[41px] shrink-0 items-center gap-2 border-t border-dock-line p-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {engaged && recState !== 'stopping' ? (
            <>
              {canPause ? (
                <button
                  type="button"
                  disabled={!live && !isPaused}
                  onClick={() => (isPaused ? onResumeRecording : onPauseRecording)?.()}
                  className={DOCK_CTL}
                  aria-label={
                    isPaused ? t('recording.actions.resume') : t('recording.actions.pause')
                  }
                >
                  {isPaused ? (
                    <Play className="size-[15px] fill-current" />
                  ) : (
                    <Pause className="size-[15px] fill-current" />
                  )}
                </button>
              ) : null}
              <Waveform
                wide
                active={live}
                pending={recState === 'starting'}
                className={`${onOpenNote ? 'w-[34px] sm:w-[60px]' : 'w-[60px]'} shrink-0 ${isPaused ? 'text-rec/45' : 'text-rec'}`}
              />
              <span className="min-w-[38px] text-center text-xs font-medium tabular-nums text-dock-ink-2">
                {formatSessionTimer(elapsedSeconds)}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled={!live && !isPaused}
                    data-onboarding="record-stop"
                    onClick={onStopRecording}
                    className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-rec-soft text-rec transition-[filter,scale] hover:brightness-105 active:scale-[0.96] disabled:opacity-50"
                    aria-label={t('recording.actions.stop')}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <rect width="14" height="14" x="5" y="5" rx="3" />
                    </svg>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{t('recording.actions.stop')}</TooltipContent>
              </Tooltip>
              <span className="flex-1" />
              {onOpenNote ? (
                <button
                  type="button"
                  onClick={onOpenNote}
                  aria-label={t('recording.away.goToNote')}
                  title={recordingNoteTitle ?? t('recording.away.goToNote')}
                  className="flex h-7 min-w-0 max-w-[160px] cursor-pointer items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-dock-ink-2 transition-colors hover:bg-dock-hover hover:text-dock-ink"
                >
                  <FileText className="size-3 shrink-0" />
                  <span className="truncate">{recordingNoteTitle ?? t('recording.away.goToNote')}</span>
                </button>
              ) : null}
              <DockMicMenu />
            </>
          ) : recState === 'stopping' || isFinishing || settling ? (
            <>
              <span className="flex pl-1.5 text-dock-ink-2">
                <PxOrbitLoader />
              </span>
              <span className="shimmer shimmer-duration-1400 min-w-0 truncate text-dock-ink-3 text-[12.5px]">
                {t('recording.panel.finishing')}
              </span>
              <span className="flex-1" />
            </>
          ) : doneMode && finished ? (
            <>
              <span className="flex shrink-0 items-center gap-1.5 px-1 text-[12.5px] text-dock-ink-2">
                <Check className="size-3.5 text-success" />
                {t('recording.panel.saved')} · {savedDuration}
              </span>
              {!doneReady ? (
                <>
                  <span className="flex text-dock-ink-2">
                    <PxOrbitLoader />
                  </span>
                  <span className="shimmer shimmer-duration-1400 min-w-0 truncate text-dock-ink-3 text-[12.5px]">
                    {enhanceWaiting
                      ? t('recording.panel.waitingForTranscription')
                      : finished.lines.length === 0
                        ? t('recording.panel.transcribing')
                        : t('recording.panel.identifyingSpeakers')}
                  </span>
                </>
              ) : (
                <span
                  className={`min-w-0 truncate text-[12.5px] font-medium ${doneOutcome === 'ready' ? 'text-success' : 'text-warning'}`}
                >
                  {doneOutcome === 'noTranscript'
                    ? t('recording.panel.transcriptionFailed')
                    : doneOutcome === 'noSpeakers'
                      ? t('recording.panel.speakerLabelsUnavailable')
                      : t('recording.panel.transcriptReady')}
                </span>
              )}
              <span className="flex-1" />
              {/* Only while a failed run is holding the bar open: the timer is suppressed then, so
                this is the one way to close an error the user does not want to retry. */}
              {holdOpen ? (
                <button
                  type="button"
                  onClick={() => {
                    clearFailedRecording(finished.id);
                    clearWaitingRecording(finished.id);
                    setDoneDismissed(true);
                  }}
                  aria-label={t('common.actions.close')}
                  className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-dock-ink-3 opacity-70 transition-opacity hover:opacity-100"
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </>
          ) : (
            <>
              {!hideStartRecording ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-onboarding="record-start"
                      aria-disabled={!!startBlockedReason}
                      onClick={startBlockedReason ? undefined : onStartRecording}
                      className="group flex h-7 cursor-pointer aria-disabled:cursor-not-allowed aria-disabled:text-dock-ink-3 items-center gap-2 rounded-lg px-2.5 text-[12.5px] font-medium text-dock-ink transition-[background-color,scale] hover:bg-dock-hover active:scale-[0.97]"
                    >
                      <span className="size-2 shrink-0 rounded-full bg-rec group-aria-disabled:bg-dock-ink-3" />
                      {t('recording.actions.start')}
                    </button>
                  </TooltipTrigger>
                  {startBlockedReason ? (
                    <TooltipContent side="top">{startBlockedReason}</TooltipContent>
                  ) : null}
                </Tooltip>
              ) : null}
              <span className="flex-1" />
              <DockMicMenu />
            </>
          )}
        </div>
        <div className="ml-auto min-w-0 max-w-[50%] shrink-0">
          {skillStatus ? skillStatus(enhanceAction, engaged || isFinishing || settling || (!!finished && !doneReady) || settledEmpty) : enhanceAction}
        </div>
      </div>
    </div>
  );
}

interface Turn {
  /** The first line's id — stable key for the turn. */
  id: string;
  /** Grouping identity: speakerKey when present, else the display label (legacy lines). */
  key: string;
  speaker: string;
  /** Clock time of the turn's first line. */
  at: string;
  lines: TranscriptLine[];
}

// Consecutive lines from the SAME speaker collapse into one turn (head shown once) —
// transcription emits many short segments per utterance. Grouping keys on
// speakerKey when present (registry-driven) with the display label fallback.
function groupTurns(lines: TranscriptLine[]): Turn[] {
  const turns: Turn[] = [];
  for (const line of lines) {
    const key = line.speakerKey ?? line.speaker;
    const last = turns[turns.length - 1];
    if (last && last.key === key) last.lines.push(line);
    else turns.push({ id: line.id, key, speaker: line.speaker, at: line.at, lines: [line] });
  }
  return turns;
}

/** Stable hue for a diarized speaker — same trick as people-display's hueFromString. */
function speakerHue(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

/** "Speaker 2" → "S2", "Priya Shah" → "PS". */
function speakerInitials(label: string): string {
  const words = label.trim().split(/\s+/);
  const init = words
    .map(w => w[0] ?? '')
    .slice(0, 2)
    .join('');
  return (init || '?').toUpperCase();
}

// Message-bubble transcript: each turn is a chat message — "them"
// (and diarized speakers) on the left in a field-toned bubble, "you" on the
// right in a primary bubble; the head carries avatar + name + clock time.
// Diarized speakers keep click-to-rename; live channel labels carry the
// speakers-settle-later explanation as a hover tooltip.
function TranscriptBubbles({
  lines,
  viewer,
  speakers,
  onRenameSpeaker,
  live = false,
}: {
  lines: TranscriptLine[];
  viewer: { name: string | null; email: string | null; image: string | null };
  speakers?: RecordingSpeakerInfo[];
  onRenameSpeaker?: (speakerId: string, displayName: string | null) => void;
  live?: boolean;
}) {
  const { t } = useTranslation();
  const turns = React.useMemo(() => groupTurns(lines), [lines]);
  const registry = React.useMemo(
    () => new Map((speakers ?? []).map(s => [s.speakerKey, s])),
    [speakers]
  );
  // Keyed by TURN id, not speaker key: a speaker has many non-consecutive turns, and keying on
  // the speaker would mount one autoFocus input per turn — each later focus blurs the previous,
  // whose onBlur commits + closes, so the editor self-destructed before the user could type.
  const [renaming, setRenaming] = React.useState<{
    turnId: string;
    key: string;
    value: string;
  } | null>(null);

  const commitRename = (speakerId: string) => {
    if (!renaming || !onRenameSpeaker) return setRenaming(null);
    const trimmed = renaming.value.trim();
    onRenameSpeaker(speakerId, trimmed.length ? trimmed : null);
    setRenaming(null);
  };

  return (
    // ph-mask-content: transcript text is masked in PostHog session recordings.
    <div className="ph-mask-content flex flex-col gap-2.5">
      {turns.map(turn => {
        const you = turn.key === 'you' || turn.speaker === t('recording.panel.you');
        const entry = registry.get(turn.key);
        const label = entry?.displayName ?? turn.speaker;
        const diarized = turn.key.startsWith('dz:');
        const hue = speakerHue(diarized ? turn.key : label);
        const renamable = diarized && !!entry && !!onRenameSpeaker;
        return (
          <div
            key={turn.id}
            className={`flex max-w-[78%] flex-col gap-1 ${
              you ? 'items-end self-end' : 'items-start self-start'
            }`}
          >
            <div className={`flex items-center gap-1.5 px-0.5 ${you ? 'flex-row-reverse' : ''}`}>
              {you ? (
                <UserAvatar
                  name={viewer.name}
                  email={viewer.email}
                  image={viewer.image}
                  size="sm"
                  fallbackClassName="text-2xs font-semibold"
                />
              ) : diarized || live ? (
                <Avatar size="sm">
                  <AvatarFallback
                    className="text-2xs font-semibold text-white"
                    style={{ backgroundColor: `hsl(${hue} 52% 38%)` }}
                  >
                    {speakerInitials(label)}
                  </AvatarFallback>
                </Avatar>
              ) : (
                <Avatar size="sm">
                  <AvatarFallback className="bg-[var(--speaker-them-soft)] text-[var(--speaker-them)]">
                    <User className="size-3.5" />
                  </AvatarFallback>
                </Avatar>
              )}
              {renamable && renaming?.turnId === turn.id ? (
                <input
                  autoFocus
                  value={renaming.value}
                  maxLength={120}
                  onChange={e =>
                    setRenaming({ turnId: turn.id, key: turn.key, value: e.target.value })
                  }
                  onBlur={() => commitRename(entry!.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitRename(entry!.id);
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  className="h-5 w-32 rounded-[5px] bg-dock-field px-1.5 text-2xs font-semibold text-dock-ink outline-none"
                  aria-label={t('recording.panel.speakerName')}
                />
              ) : (
                <span
                  className={`text-2xs font-semibold ${
                    you ? 'text-dock-ink' : diarized || live ? '' : 'text-[var(--speaker-them)]'
                  } ${renamable ? 'cursor-pointer underline-offset-2 hover:underline' : ''}`}
                  style={diarized || (live && !you) ? { color: `hsl(${hue} 45% 52%)` } : undefined}
                  // Live channel labels settle into real names after the stop —
                  // the tooltip carries that expectation (was a persistent banner).
                  title={
                    renamable
                      ? t('recording.actions.renameSpeaker')
                      : live && !you
                        ? t('recording.panel.liveExpectation')
                        : undefined
                  }
                  {...(renamable
                    ? {
                        role: 'button',
                        tabIndex: 0,
                        onClick: () =>
                          setRenaming({
                            turnId: turn.id,
                            key: turn.key,
                            value: entry!.displayName ?? '',
                          }),
                        onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setRenaming({
                              turnId: turn.id,
                              key: turn.key,
                              value: entry!.displayName ?? '',
                            });
                          }
                        },
                      }
                    : {})}
                >
                  {label}
                </span>
              )}
              {/* `at` carries a 12-hour clock ("11:41 PM"). */}
              <span className="font-mono text-2xs tabular-nums text-dock-ink-3">{turn.at}</span>
            </div>
            {turn.lines.map(line => (
              <p
                key={line.id}
                className={`rounded-xl px-2.5 py-1.5 text-[13px] leading-normal ${
                  you
                    ? 'rounded-tr-[4px] bg-primary text-primary-foreground'
                    : 'rounded-tl-[4px] bg-dock-field text-dock-ink'
                }`}
              >
                {line.text}
              </p>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function MiniAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className="flex size-[22px] items-center justify-center rounded-md text-dock-ink-3 transition-colors hover:bg-dock-hover hover:text-dock-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
