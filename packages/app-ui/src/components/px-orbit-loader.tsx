// Pixel-orbit loader: a
// 3×3 grid of 4px cells whose outer ring lights up clockwise while the center
// stays dim. Used for the record panel's processing states ("Finishing up…",
// "Transcribing…") — reads as deliberate work where a waveform would read as
// audio. Color rides on currentColor.

// Clockwise ring order for the 1-indexed grid cells (row-major): top row 1→2→3,
// right edge 6, bottom row 9→8→7, left edge 4. Cell 5 is the static center.
const PX_ORDER: Record<number, number> = { 1: 0, 2: 1, 3: 2, 6: 3, 9: 4, 8: 5, 7: 6, 4: 7 };

export function PxOrbitLoader({ className = '' }: { className?: string }) {
  return (
    <span
      className={`grid shrink-0 grid-cols-3 gap-[1.5px] ${className}`}
      role="status"
      aria-hidden="true"
    >
      {Array.from({ length: 9 }, (_, i) => {
        const n = i + 1;
        return n === 5 ? (
          <i key={n} className="size-1 rounded-[1px] bg-current opacity-30" />
        ) : (
          <i
            key={n}
            className="size-1 animate-[px-orbit_1.2s_linear_infinite] rounded-[1px] bg-current opacity-15 motion-reduce:animate-none"
            style={{ animationDelay: `${((PX_ORDER[n] ?? 0) * 0.15).toFixed(2)}s` }}
          />
        );
      })}
    </span>
  );
}
