import { cn } from '../lib/utils';

// Per-bar height factors give the row a "mountain" silhouette — tallest in the
// middle, shorter at the edges (matches the desktop Waveform component).
const BAR_FACTORS = [0.45, 0.65, 0.85, 1.0, 0.85, 0.65] as const;

interface WaveformProps {
  className?: string;
  /** When true the bars animate with a traveling-wave effect. */
  active?: boolean;
  /** Starting/stopping: bars breathe in unison — "working on it", not hung.
   * `active` wins when both are set. */
  pending?: boolean;
  /** Panel-bar scale: 26px tall, 3.5px bars, 3px gap
   * — the pill keeps the default 20px/3px/2px. */
  wide?: boolean;
}

/**
 * CSS-only waveform row — 6 thin rounded bars that oscillate with staggered
 * delays when `active`, pulse gently in unison when `pending` (recording
 * starting/stopping), and sit at a low resting height when idle.
 *
 * Color is controlled entirely by the parent's `text-*` class via `bg-current`.
 * No framer-motion; animation runs purely through the `waveform-bar` /
 * `waveform-bar-pending` keyframes defined in tokens.css.
 */
export function Waveform({
  className,
  active = false,
  pending = false,
  wide = false,
}: WaveformProps) {
  return (
    <div
      className={cn(
        'flex items-end justify-center',
        wide ? 'gap-[3px] h-[26px]' : 'gap-[2px] h-5',
        className
      )}
    >
      {BAR_FACTORS.map((factor, i) => (
        <div
          key={i}
          // waveform-bar-anim: tokens.css disables the inline keyframe animations
          // under prefers-reduced-motion (inline styles need the !important rule).
          className={cn(
            'waveform-bar-anim rounded-full bg-current origin-bottom',
            wide ? 'w-[3.5px]' : 'w-[3px]'
          )}
          style={
            active
              ? {
                  height: `${Math.round(factor * 100)}%`,
                  animation: `waveform-bar 0.9s ease-in-out infinite`,
                  animationDelay: `${i * 0.08}s`,
                }
              : pending
                ? {
                    height: `${Math.round(factor * 100)}%`,
                    // No stagger: the in-unison breath reads as a loader, not audio.
                    animation: `waveform-bar-pending 1.1s ease-in-out infinite`,
                  }
                : {
                    // Resting height for a paused waveform.
                    height: '30%',
                    // Respect the user's reduced-motion preference even in idle
                    // state — bars remain static.
                    transition: 'height 0.15s ease-out',
                  }
          }
        />
      ))}
    </div>
  );
}
