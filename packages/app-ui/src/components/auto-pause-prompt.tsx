'use client';

import * as React from 'react';
import { Mic, Pause } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The "Still there?" grace prompt — web's rendering of the auto-pause machine's
 * `show-grace` effect, and a deliberate sibling of the desktop notify card: amber
 * accent bar, two-line content, actions right, a thin progress loader as the countdown. Same
 * decision, same shape, two surfaces.
 *
 * The loader is COSMETIC. Authority over when the pause commits lives on the sample clock in
 * `@prismical/silence` (background tabs throttle timers but keep delivering audio), so if this
 * bar finishes early nothing happens until the audio actually agrees — the same split 166 uses
 * between its renderer animation and main-side expiry.
 *
 * Every affordance here except Pause resolves to "keep recording", including dismissing the
 * toast: touching it at all proves a human is present, which is exactly what the silence detector
 * was guessing at.
 */
export function AutoPausePrompt({
  graceMs,
  onKeepRecording,
  onPause,
}: {
  graceMs: number;
  onKeepRecording: () => void;
  onPause: () => void;
}) {
  const { t } = useTranslation();
  // Start full, then transition to empty over the grace window. Two frames of delay so the
  // browser commits the starting width before the transition begins (a single rAF can coalesce
  // with the initial paint and skip the animation entirely).
  const [running, setRunning] = React.useState(false);
  React.useEffect(() => {
    // Two handles, not one: cancelling only the outer leaves the inner uncancellable if the outer
    // has already fired, so a prompt withdrawn within a frame of mounting still sets state after
    // unmount.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setRunning(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner) cancelAnimationFrame(inner);
    };
  }, []);

  return (
    <div className="relative w-[356px] overflow-hidden rounded-xl border border-dock-line bg-dock-surface shadow-(--dock-shadow-raised)">
      {/* Notice-card chrome: opaque theme-aware surface with a 3px amber
          accent bar. */}
      <div className="flex items-start gap-3 p-3.5">
        <div className="mt-0.5 h-8 w-[3px] shrink-0 rounded-full bg-amber-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-dock-ink">
            {t('recording.autoPause.title')}
          </p>
          <p className="mt-0.5 text-[12.5px] leading-snug text-dock-ink-2">
            {t('recording.autoPause.description')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onKeepRecording}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-dock-field px-2.5 py-1.5 text-xs font-medium text-dock-ink transition-colors hover:bg-dock-hover"
          >
            <Mic className="h-3.5 w-3.5" />
            {t('recording.autoPause.keepRecording')}
          </button>
          <button
            type="button"
            onClick={onPause}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-dock-ink-2 transition-colors hover:bg-dock-hover hover:text-dock-ink"
          >
            <Pause className="h-3.5 w-3.5" />
            {t('recording.autoPause.pause')}
          </button>
        </div>
      </div>
      {/* The countdown. `transition-[width] linear` over the full grace window. */}
      <div className="absolute inset-x-0 bottom-0 h-0.5 bg-dock-line">
        <div
          className="h-full bg-amber-400/80 transition-[width] ease-linear"
          style={{ width: running ? '0%' : '100%', transitionDuration: `${graceMs}ms` }}
        />
      </div>
    </div>
  );
}
