'use client';

import * as React from 'react';
import { AudioLines, Loader2, Pause, Play } from 'lucide-react';
import type { RecState } from '@prismical/app-client';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { Waveform } from './waveform';
import { DOCK_CTL, DOCK_CTL_INK2 } from './dock-chrome';
import { useTranslation } from 'react-i18next';

type RecordingPillFaceProps = {
  recState: RecState;
  startBlockedReason?: string;
  /** Pause/resume is available for this capture path when supported.
   * False hides the pause button entirely — the pill keeps its two-control layout. */
  canPause?: boolean;
  isPanelOpen: boolean;
  onTogglePanel: () => void;
  onStopRecording: () => void;
  onPauseRecording?: () => void;
  onResumeRecording?: () => void;
  /** Cluster-owned session seconds (timestamp-derived, pause-aware). */
  elapsedSeconds: number;
};

/** Pill-face width for the current state — the DockUnit animates to it. */
export function recordingPillWidth(recState: RecState, canPause: boolean, compact = false): number {
  const engaged = recState !== 'idle';
  // Compact = the floating note window's smaller dock scale. Only the IDLE
  // pill shrinks; the live pill must fit its 28px control atoms.
  return engaged ? (canPause ? 152 : 120) : compact ? 44 : 52;
}

/** m:ss, h:mm:ss past the hour. */
export function formatSessionTimer(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * The Record unit's pill face: idle it's a single control that
 * expands the panel (starting a recording lives in the panel's bottom bar);
 * engaged it morphs into [pause] · waveform · timer · stop, where the
 * waveform+timer strip doubles as the expand-the-panel target. The full
 * control set also lives in the expanded panel's own bar — the pill is the
 * minimized mirror, so stop/pause stay one click away in BOTH faces.
 *
 * The morph is driven by the full RecState, not just isRecording: the pill
 * commits to the recording layout the moment the session starts (state
 * "starting"), with a static waveform and a disarmed stop button, so the
 * start choreography is ONE movement.
 */
export function RecordingPillFace({
  recState,
  startBlockedReason,
  canPause = false,
  isPanelOpen,
  onTogglePanel,
  onStopRecording,
  onPauseRecording,
  onResumeRecording,
  elapsedSeconds,
}: RecordingPillFaceProps) {
  const { t } = useTranslation();
  // engaged = pill shows the recording layout (from the click, through stopping);
  // live = audio is actually flowing — waveform animates, stop is armed;
  // paused = session alive but suspended — waveform dims/stills, the middle button
  // shows Play;
  // pending = start/stop plumbing is in flight — the waveform pulses in unison
  // and (while stopping) the stop button spins, so the wait reads as progress
  // rather than a hang.
  const engaged = recState !== 'idle';
  const live = recState === 'recording';
  const paused = recState === 'paused';
  const pending = recState === 'starting' || recState === 'stopping';
  // stopping → idle: the engaged layer takes ~120ms to fade out (and the pill
  // 240ms to collapse), but recState has already flipped — without this, the
  // spinner swapped BACK to the stop square mid-fade, a visible flash at the end
  // of every stop. Derived, not a timer: whenever the engaged layer is visible
  // at `idle` it is precisely the post-stop fading ghost (at rest the layer is
  // invisible/inert, so what it renders is moot).
  const showSaving = recState === 'stopping' || !engaged;
  const idlePanelLabel = isPanelOpen
    ? t('recording.actions.hideTranscription')
    : startBlockedReason
      ? t('recording.actions.showTranscription')
      : t('recording.actions.start');

  return (
    <TooltipProvider>
      <div className="relative h-full w-full">
        {/* Idle: one control — expand the record panel (Start lives in its bar). */}
        <div
          className={`absolute inset-0 flex items-center justify-center transition-opacity ${
            engaged
              ? 'pointer-events-none opacity-0 delay-0 duration-75'
              : 'opacity-100 delay-100 duration-100'
          }`}
          {...(engaged ? { inert: true } : {})}
          aria-hidden={engaged}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              {/* The WHOLE pill face is the click target (same interaction as
                  the New-note pill next door — the inner 28px ctl left dead
                  zones around it, user feedback). */}
              <button
                type="button"
                data-onboarding="record-open"
                // Reviewing a suggestion must not block access to its source transcript.
                // The panel's capture action enforces the recording gate.
                onClick={onTogglePanel}
                className="flex h-full w-full cursor-pointer items-center justify-center text-dock-ink-2 transition-[background-color,color] hover:bg-dock-hover hover:text-dock-ink active:scale-95"
                aria-label={idlePanelLabel}
              >
                <AudioLines className="size-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{idlePanelLabel}</TooltipContent>
          </Tooltip>
        </div>

        {/* Engaged: [pause] · waveform · timer · stop. The waveform+timer strip is the
            expand target (the panel is where the live transcript lives). */}
        <div
          data-onboarding={recState === 'starting' ? 'record-pending' : undefined}
          className={`absolute inset-0 flex items-center justify-center gap-[3px] px-[5px] transition-opacity ${
            engaged
              ? 'opacity-100 delay-75 duration-100'
              : 'pointer-events-none opacity-0 delay-0 duration-50'
          }`}
          {...(!engaged ? { inert: true } : {})}
          aria-hidden={!engaged}
        >
          {canPause ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  disabled={!live && !paused}
                  onClick={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    (paused ? onResumeRecording : onPauseRecording)?.();
                  }}
                  className={DOCK_CTL_INK2}
                  aria-label={paused ? t('recording.actions.resume') : t('recording.actions.pause')}
                >
                  {paused ? (
                    <Play className="size-[15px] fill-current" />
                  ) : (
                    <Pause className="size-[15px] fill-current" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {paused ? t('recording.actions.resume') : t('recording.actions.pause')}
              </TooltipContent>
            </Tooltip>
          ) : null}
          {/* NOT pending||showSaving: showSaving is true at rest (hidden layer), and an
              always-running pulse in an invisible layer would tick the compositor forever.
              The pending→idle bar snap lands inside the fade-out — imperceptible. */}
          <button
            type="button"
            data-onboarding="record-live-open"
            onClick={onTogglePanel}
            className="flex h-full min-w-0 flex-1 cursor-pointer flex-col items-center justify-center rounded-lg transition-colors hover:bg-dock-hover"
            aria-label={
              isPanelOpen
                ? t('recording.actions.hideTranscription')
                : t('recording.actions.showTranscription')
            }
          >
            <span className="flex items-center justify-center gap-[3px]">
              <Waveform
                active={live}
                pending={pending}
                className={`w-[34px] shrink-0 transition-colors ${
                  paused ? 'text-rec/45' : 'text-rec'
                }`}
              />
              <span className="min-w-[34px] text-center text-xs font-medium tabular-nums text-dock-ink-2">
                {formatSessionTimer(elapsedSeconds)}
              </span>
            </span>
          </button>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-onboarding="record-stop"
                disabled={!live && !paused}
                onClick={e => {
                  e.preventDefault();
                  e.stopPropagation();
                  onStopRecording();
                }}
                className={`${DOCK_CTL} text-rec`}
                aria-label={t('recording.actions.stop')}
                aria-busy={showSaving}
              >
                {/* Stopping (and the fade-out right after) = flush + finalize in flight;
                    the spinner says "saving", where a frozen stop square read as a hang.
                    The idle-spin-pause rule in tokens.css stops it from
                    ticking the compositor while the layer sits hidden at rest. */}
                {showSaving ? (
                  <Loader2 className="size-[15px] animate-spin text-dock-ink-2 motion-reduce:animate-none" />
                ) : (
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <rect width="14" height="14" x="5" y="5" rx="3" />
                  </svg>
                )}
              </button>
            </TooltipTrigger>
            {/* Disabled buttons never emit the events Radix tooltips need, so no
                starting/stopping variants — only the armed state can show one. */}
            <TooltipContent side="top">{t('recording.actions.stop')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}
