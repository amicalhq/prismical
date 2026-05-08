export const TAG_PRESETS = [
  "#f59e0b",
  "#10b981",
  "#60a5fa",
  "#a78bfa",
  "#f472b6",
  "#94a3b8",
  "#fb923c",
] as const;

const HEX_RE = /^#[0-9a-f]{6}$/;

export function isValidHex(s: string): boolean {
  return HEX_RE.test(s);
}

export function normalizeHex(s: string): string | null {
  const lower = s.toLowerCase();
  return isValidHex(lower) ? lower : null;
}

export function nextAutoColor(existingTagCount: number): string {
  const i =
    ((existingTagCount % TAG_PRESETS.length) + TAG_PRESETS.length) %
    TAG_PRESETS.length;
  return TAG_PRESETS[i];
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

// WCAG-style relative luminance
function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function hasSufficientContrast(
  hex: string,
  theme: "light" | "dark",
): boolean {
  const L = luminance(hex);
  // chip text vs theme background — require a luminance gap
  if (theme === "dark") return L > 0.18; // too dark on dark = unreadable
  return L < 0.78; // too light on light = unreadable
}

export interface ChipStyles {
  background: string;
  border: string;
  foreground: string;
}

export function tagChipStyles(
  hex: string,
  theme: "light" | "dark",
): ChipStyles {
  const { r, g, b } = hexToRgb(hex);
  const fallback = theme === "dark" ? "#e6e6e6" : "#1a1a1a";
  return {
    background: `rgba(${r}, ${g}, ${b}, 0.18)`,
    border: `rgba(${r}, ${g}, ${b}, 0.35)`,
    foreground: hasSufficientContrast(hex, theme) ? hex : fallback,
  };
}
