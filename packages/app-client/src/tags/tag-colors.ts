/**
 * Tag color palette and auto-assignment.
 *
 * A web-created tag gets the same palette and "least-used" pick as the desktop client. The presets
 * are hex — valid CSS colors, so they render directly in
 * the chip styles (`backgroundColor` / `color-mix`) just like the existing oklch seed colors.
 * The stored color is free-form text end to end (the column and the API schema take any string),
 * so a tag may also carry a custom color the user picked outside this palette.
 */

/**
 * The palette shown in the picker, ordered by hue so the swatch grid reads as a spectrum.
 * Values are Tailwind 400/500 tones — bright enough on the light surface, not blinding on the dark
 * one.
 */
export const TAG_PRESETS = [
  "#ef4444", // red
  "#fb923c", // orange
  "#f59e0b", // amber
  "#facc15", // yellow
  "#a3e635", // lime
  "#4ade80", // green
  "#10b981", // emerald
  "#2dd4bf", // teal
  "#22d3ee", // cyan
  "#38bdf8", // sky
  "#60a5fa", // blue
  "#818cf8", // indigo
  "#a78bfa", // violet
  "#c084fc", // purple
  "#e879f9", // fuchsia
  "#f472b6", // pink
  "#fb7185", // rose
  "#94a3b8", // slate
  "#a8a29e", // stone
  "#a1a1aa", // zinc
] as const;

export type TagPreset = (typeof TAG_PRESETS)[number];

/**
 * The order auto-assignment walks. Deliberately NOT the display order: consecutive tags should look
 * clearly different, and hue order would hand the first few tags red/orange/amber. This is a
 * permutation of TAG_PRESETS that hops around the wheel, starting with the original seven presets
 * so existing installs keep assigning the colors they always did.
 */
export const TAG_AUTO_ASSIGN_ORDER = [
  "#f59e0b", // amber
  "#10b981", // emerald
  "#60a5fa", // blue
  "#a78bfa", // violet
  "#f472b6", // pink
  "#94a3b8", // slate
  "#fb923c", // orange
  "#22d3ee", // cyan
  "#c084fc", // purple
  "#4ade80", // green
  "#ef4444", // red
  "#38bdf8", // sky
  "#facc15", // yellow
  "#818cf8", // indigo
  "#2dd4bf", // teal
  "#e879f9", // fuchsia
  "#a3e635", // lime
  "#fb7185", // rose
  "#a8a29e", // stone
  "#a1a1aa", // zinc
] as const satisfies readonly TagPreset[];

/**
 * Pick the preset used by the fewest existing tags. Ties go to the preset earliest in
 * TAG_AUTO_ASSIGN_ORDER for stability. A color outside the preset set (e.g. a legacy oklch seed
 * color, or one the user picked with the custom picker) simply doesn't count toward any preset's
 * usage — so early tags fill unused presets first.
 */
export function nextAutoColor(existingColors: readonly string[]): string {
  const usage = new Map<string, number>(TAG_AUTO_ASSIGN_ORDER.map((c) => [c, 0]));
  for (const c of existingColors) {
    if (usage.has(c)) usage.set(c, (usage.get(c) ?? 0) + 1);
  }
  let best: TagPreset = TAG_AUTO_ASSIGN_ORDER[0];
  let bestCount = usage.get(best) ?? 0;
  for (const c of TAG_AUTO_ASSIGN_ORDER) {
    const n = usage.get(c) ?? 0;
    if (n < bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Normalize a hex color to lowercase 6-digit form, so `#ABC` and `#aabbcc` compare equal against the
 * presets — `tag.color` is free-form text end to end, so a color written through the public API
 * needn't match the palette's casing. Returns null when the input isn't a hex color.
 */
export function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!HEX_COLOR.test(trimmed)) return null;
  if (trimmed.length === 7) return trimmed;
  const [, r, g, b] = trimmed;
  return `#${r}${r}${g}${g}${b}${b}`;
}

/**
 * Ink that stays readable ON a swatch of `color` — the selected-swatch checkmark sits on top of the
 * fill, and the palette spans yellow/lime, where white is barely visible. Uses the sRGB
 * relative-luminance threshold; a non-hex color (a legacy oklch seed) can't be measured here, so it
 * falls back to white as before.
 */
export function swatchInk(color: string): "#000000" | "#ffffff" {
  const hex = normalizeHexColor(color);
  if (!hex) return "#ffffff";
  const channel = (offset: number) => {
    const srgb = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.45 ? "#000000" : "#ffffff";
}
