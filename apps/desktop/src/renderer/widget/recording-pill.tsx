/**
 * Recording pill — the collapsed
 * waveform expands on hover to the flat control cluster
 * `[⏸/▶][■][waveform+timer][📓]` (pause/resume is `canPause`-gated). The pill
 * BODY is a click target — clicking the waveform/timer
 * opens the app on the active note; the flat buttons stop
 * propagation. `paused` stills+dims the bars, shows an amber pause glyph and
 * freezes the timer.
 */
import { AlertTriangle, Loader2, Mic, Pause } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { StopButton, NotesIconButton, PauseButton, ResumeButton } from './widget-buttons';
import { PILL_SHELL_CLASS } from './idle-pill';
import { ElapsedTimer } from './elapsed-timer';
import { Waveform } from './waveform';

const NUM_WAVEFORM_BARS_HOVERED = 6;
const NUM_WAVEFORM_BARS_COLLAPSED = 4;

export interface RecordingPillProps {
  hovered: boolean;
  status: 'starting' | 'recording' | 'paused' | 'stopping' | 'error';
  /** The effective capture fell back to mic-only. */
  micOnly: boolean;
  /** Pause/resume render only when the recording domain reports the capability. */
  canPause: boolean;
  elapsedMs: number;
  elapsedAt: number | null;
  /** The latest pushed capture level (0..1), or null → synthetic pulse. */
  level: number | null;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  onOpenNote: () => void;
  /** Pill body click — open the app on the active note. */
  onOpenApp: () => void;
}

export function RecordingPill({
  hovered,
  status,
  micOnly,
  canPause,
  elapsedMs,
  elapsedAt,
  level,
  onStop,
  onPause,
  onResume,
  onOpenNote,
  onOpenApp,
}: RecordingPillProps) {
  const { t } = useTranslation();
  const isError = status === 'error';
  const isBusy = status === 'starting' || status === 'stopping';
  const isPaused = status === 'paused';

  const hoveredWidth = canPause ? 236 : 206;

  return (
    <div
      data-hit-zone="true"
      style={{ height: hovered ? 42 : 44, width: hovered ? hoveredWidth : 44 }}
      className={`${PILL_SHELL_CLASS} flex items-center justify-center overflow-hidden transition-all duration-200 ease-out ${hovered ? 'gap-1 rounded-[14px] px-1.5' : 'rounded-full'}`}
    >
      {/* Mic-only degrade hint: a small amber glyph, layout-neutral. */}
      {micOnly && (
        <span
          className="absolute left-1 top-1 z-10 text-[var(--warning)]"
          aria-label={t('desktop.widget.micOnly')}
          title={t('desktop.widget.micOnly')}
        >
          <Mic className="size-[10px]" />
        </span>
      )}

      {/* Collapsed paused pill: the amber glyph IS the state signal. */}
      {!hovered && isPaused && (
        <span className="absolute z-10 text-[var(--warning)]">
          <Pause className="size-[14px] fill-current" />
        </span>
      )}

      {hovered &&
        (isBusy ? (
          <span className="flex size-7 flex-none items-center justify-center text-[var(--dock-ink-2)]">
            <Loader2 className="size-5 animate-spin" />
          </span>
        ) : isError ? (
          <span className="flex size-7 flex-none items-center justify-center text-[var(--rec)]">
            <AlertTriangle className="size-[18px]" />
          </span>
        ) : (
          canPause &&
          (isPaused ? <ResumeButton onClick={onResume} /> : <PauseButton onClick={onPause} />)
        ))}

      {/* The waveform+timer cluster IS the "open the app" click target (spec:
          pill BODY click, scoped so a slip-release off a control button can
          never trigger it). Collapsed, this cluster is the whole visible pill. */}
      <div
        role="button"
        aria-label={t('desktop.widget.openApp')}
        onClick={onOpenApp}
        className="flex cursor-pointer items-center gap-[6px]"
      >
        {hovered && isPaused && (
          <span className="text-[var(--warning)]">
            <Pause className="size-[13px] fill-current" />
          </span>
        )}
        <Waveform
          active={status === 'recording' || isPaused}
          paused={isPaused}
          bars={hovered ? NUM_WAVEFORM_BARS_HOVERED : NUM_WAVEFORM_BARS_COLLAPSED}
          hovered={hovered}
          level={level}
        />
        {hovered && (
          <ElapsedTimer
            elapsedMs={elapsedMs}
            elapsedAt={elapsedAt}
            running={status === 'recording'}
          />
        )}
      </div>

      {hovered && !isBusy && !isError && <StopButton onClick={onStop} />}
      {hovered && <NotesIconButton onClick={onOpenNote} />}
    </div>
  );
}
