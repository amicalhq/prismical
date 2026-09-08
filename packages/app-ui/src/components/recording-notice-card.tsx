'use client';

import * as React from 'react';

/**
 * The dock's notice-card anatomy: an accent bar, two lines of content, actions on the right, and
 * an optional countdown loader along the bottom. Extracted from the auto-pause "Still there?"
 * prompt so every mid-recording notice reads as the same object — a session about to end, a
 * transcription allowance about to run out, and the silence prompt are one family, and the user
 * should not have to learn three shapes for "this recording is about to change".
 *
 * Rendered inside a `toast.custom`, so it owns its chrome rather than inheriting the toaster's.
 */
export interface RecordingNoticeAction {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  /** Filled affordance. At most one per card; the rest read as quiet text buttons. */
  emphasis?: boolean;
}

export function RecordingNoticeCard({
  title,
  description,
  actions,
  countdownMs,
}: {
  title: string;
  description?: string;
  actions: readonly RecordingNoticeAction[];
  /** When set, a cosmetic bar drains over this window. Omit for a notice with no deadline. */
  countdownMs?: number;
}) {
  // Start full, then transition to empty. Two frames of delay so the browser commits the starting
  // width before the transition begins (a single rAF can coalesce with the initial paint and skip
  // the animation entirely).
  const [running, setRunning] = React.useState(false);
  React.useEffect(() => {
    if (countdownMs === undefined) return;
    // Two handles, not one: cancelling only the outer leaves the inner uncancellable if the outer
    // has already fired, so a card withdrawn within a frame of mounting still sets state after
    // unmount.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setRunning(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner) cancelAnimationFrame(inner);
    };
  }, [countdownMs]);

  return (
    <div className="relative w-[356px] overflow-hidden rounded-xl border border-dock-line bg-dock-surface shadow-(--dock-shadow-raised)">
      <div className="flex items-start gap-3 p-3.5">
        <div className="mt-0.5 h-8 w-[3px] shrink-0 rounded-full bg-amber-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-dock-ink">{title}</p>
          {description ? (
            <p className="mt-0.5 text-[12.5px] leading-snug text-dock-ink-2">{description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {actions.map(action => (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              className={
                action.emphasis
                  ? 'flex cursor-pointer items-center gap-1.5 rounded-lg bg-dock-field px-2.5 py-1.5 text-xs font-medium text-dock-ink transition-colors hover:bg-dock-hover'
                  : 'flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-dock-ink-2 transition-colors hover:bg-dock-hover hover:text-dock-ink'
              }
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>
      </div>
      {countdownMs === undefined ? null : (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-dock-line">
          <div
            className="h-full bg-amber-400/80 transition-[width] ease-linear"
            style={{ width: running ? '0%' : '100%', transitionDuration: `${countdownMs}ms` }}
          />
        </div>
      )}
    </div>
  );
}
