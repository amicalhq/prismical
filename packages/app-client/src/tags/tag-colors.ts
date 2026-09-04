/**
 * Tag color palette and auto-assignment.
 *
 * A web-created tag gets the same palette and "least-used" pick as the desktop client. The presets
 * are hex — valid CSS colors, so they render directly in
 * the chip styles (`backgroundColor` / `color-mix`) just like the existing oklch seed colors.
 */
export const TAG_PRESETS = [
  "#f59e0b",
  "#10b981",
  "#60a5fa",
  "#a78bfa",
  "#f472b6",
  "#94a3b8",
  "#fb923c",
] as const;

/**
 * Pick the preset used by the fewest existing tags. Ties go to the preset with the lowest index in
 * TAG_PRESETS for stability. A color outside the preset set (e.g. a legacy oklch seed color) simply
 * doesn't count toward any preset's usage — so early tags fill unused presets first.
 */
export function nextAutoColor(existingColors: readonly string[]): string {
  const usage = new Map<string, number>(TAG_PRESETS.map((c) => [c, 0]));
  for (const c of existingColors) {
    if (usage.has(c)) usage.set(c, (usage.get(c) ?? 0) + 1);
  }
  let best: (typeof TAG_PRESETS)[number] = TAG_PRESETS[0];
  let bestCount = usage.get(best) ?? 0;
  for (const c of TAG_PRESETS) {
    const n = usage.get(c) ?? 0;
    if (n < bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}
