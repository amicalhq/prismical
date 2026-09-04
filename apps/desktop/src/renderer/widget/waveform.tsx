/**
 * Recording waveform driven by the live capture level.
 *
 * Driven by the ~12 Hz `widget:level` push when one is flowing: each push
 * scrolls into a rolling history and the bars render the most recent samples
 * (newest at the outer end), scaleY-mapped — an actual scrolling level meter.
 * While no fresh push has arrived (starting, level lane gated, or a main
 * process that never emits) the bars fall back to the original synthetic CSS
 * pulse, so the pill never looks dead mid-recording. `paused` stills + dims
 * the bars (no animation, low opacity) — unmistakable at a glance.
 */
import { useEffect, useRef, useState } from 'react';

interface WaveformProps {
  /** Pulse while a recording is live; hold flat when starting/stopping/error. */
  readonly active: boolean;
  /** Still + dim the bars (paused recording). */
  readonly paused?: boolean;
  readonly bars: number;
  readonly hovered: boolean;
  /**
   * The latest pushed level sample (0..1), or null when none has arrived
   * recently — null selects the synthetic pulse fallback.
   */
  readonly level: number | null;
}

const MAX_HISTORY = 12;
/** Map a 0..1 level onto the bar's scaleY range (a dead-quiet room still shows a sliver). */
const levelToScale = (level: number): number => 0.25 + Math.min(1, level) * 0.75;

export function Waveform({ active, paused = false, bars, hovered, level }: WaveformProps) {
  // Rolling history of pushed levels; the newest sample lands at the end.
  const [history, setHistory] = useState<readonly number[]>([]);
  const lastLevelRef = useRef<number | null>(null);
  useEffect(() => {
    if (level === null || level === lastLevelRef.current) return;
    lastLevelRef.current = level;
    setHistory(prev => [...prev.slice(-(MAX_HISTORY - 1)), level]);
  }, [level]);
  useEffect(() => {
    if (!active) setHistory([]);
  }, [active]);

  const live = active && level !== null;

  return (
    <div
      className={`flex flex-none items-center justify-center gap-[2.5px] transition-opacity ${hovered ? 'h-[18px]' : 'h-4'} ${paused ? 'opacity-40' : ''}`}
    >
      {Array.from({ length: bars }).map((_, index) => {
        // Newest sample on the outermost bar; older history trails behind it.
        const sample = live ? history[history.length - bars + index] : undefined;
        return (
          <span
            key={index}
            className="w-[3px] origin-center rounded-full bg-[var(--rec)]"
            style={{
              height: hovered ? 16 : 12,
              animation:
                active && !paused && !live
                  ? `widget-wave 900ms ease-in-out ${index * 120}ms infinite`
                  : undefined,
              transform:
                live && !paused
                  ? `scaleY(${levelToScale(sample ?? 0)})`
                  : active && !paused
                    ? undefined
                    : 'scaleY(0.35)',
              transition: live ? 'transform 90ms linear' : undefined,
            }}
          />
        );
      })}
    </div>
  );
}
