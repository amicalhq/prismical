/**
 * Elapsed recording timer — derived entirely renderer-side
 * from the pushed accepted-sample duration + its wall-clock anchor, so paused
 * time and capture-restart gaps never inflate the media timeline. Ticks a local
 * 1s interval while running and freezes at the exact sample duration on pause.
 */
import { useEffect, useReducer } from 'react';

interface ElapsedTimerProps {
  /** Accepted-sample duration at `elapsedAt`. */
  readonly elapsedMs: number;
  /** Epoch ms when elapsedMs was sampled. */
  readonly elapsedAt: number | null;
  /** Tick while true; freeze the last derived value while false (paused). */
  readonly running: boolean;
}

const pad = (n: number): string => String(n).padStart(2, '0');

export const formatElapsed = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

export function ElapsedTimer({ elapsedMs, elapsedAt, running }: ElapsedTimerProps) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [running]);

  const elapsed =
    elapsedMs + (running && elapsedAt !== null ? Math.max(0, Date.now() - elapsedAt) : 0);

  return (
    <span className="min-w-[34px] text-center text-[12px] font-medium tabular-nums text-[var(--dock-ink-2)]">
      {formatElapsed(elapsed)}
    </span>
  );
}
