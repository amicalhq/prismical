import { describe, it, expect } from "vitest";
import {
  TAG_PRESETS,
  nextAutoColor,
  hasSufficientContrast,
  tagChipStyles,
  isValidHex,
  normalizeHex,
} from "@/renderer/main/lib/tag-colors";

describe("tag-colors", () => {
  describe("TAG_PRESETS", () => {
    it("contains exactly 7 lowercased hex strings", () => {
      expect(TAG_PRESETS).toHaveLength(7);
      for (const c of TAG_PRESETS) {
        expect(c).toMatch(/^#[0-9a-f]{6}$/);
      }
    });
  });

  describe("nextAutoColor", () => {
    it("returns the first preset when nothing is in use", () => {
      expect(nextAutoColor([])).toBe(TAG_PRESETS[0]);
    });
    it("skips a preset that is already in use once", () => {
      expect(nextAutoColor([TAG_PRESETS[0]])).toBe(TAG_PRESETS[1]);
    });
    it("picks the lowest-frequency preset", () => {
      // Presets 0..5 each used once; preset 6 used zero times → preset 6 wins.
      const colors = TAG_PRESETS.slice(0, 6);
      expect(nextAutoColor(colors)).toBe(TAG_PRESETS[6]);
    });
    it("ignores non-preset colors when computing frequency", () => {
      const colors = ["#000000", "#ffffff", TAG_PRESETS[0]];
      expect(nextAutoColor(colors)).toBe(TAG_PRESETS[1]);
    });
    it("breaks ties toward the lower-index preset", () => {
      // All zero-use → first preset; all used once → first preset.
      const oneEach = [...TAG_PRESETS];
      expect(nextAutoColor(oneEach)).toBe(TAG_PRESETS[0]);
    });
  });

  describe("isValidHex", () => {
    it("accepts canonical lowercase hex", () => {
      expect(isValidHex("#f59e0b")).toBe(true);
    });
    it("rejects uppercase", () => {
      expect(isValidHex("#F59E0B")).toBe(false);
    });
    it("rejects 3-digit shorthand", () => {
      expect(isValidHex("#fa0")).toBe(false);
    });
    it("rejects missing hash", () => {
      expect(isValidHex("f59e0b")).toBe(false);
    });
  });

  describe("normalizeHex", () => {
    it("lowercases and validates", () => {
      expect(normalizeHex("#F59E0B")).toBe("#f59e0b");
    });
    it("returns null on invalid input", () => {
      expect(normalizeHex("not a color")).toBeNull();
    });
  });

  describe("hasSufficientContrast", () => {
    it("a near-black hex fails on dark theme", () => {
      expect(hasSufficientContrast("#101010", "dark")).toBe(false);
    });
    it("a near-white hex fails on light theme", () => {
      expect(hasSufficientContrast("#f5f5f5", "light")).toBe(false);
    });
    it("a saturated mid-tone passes both themes", () => {
      expect(hasSufficientContrast("#f59e0b", "dark")).toBe(true);
      expect(hasSufficientContrast("#10b981", "light")).toBe(true);
    });
  });

  describe("tagChipStyles", () => {
    it("derives bg/border at fixed opacities and uses hex foreground when readable", () => {
      const s = tagChipStyles("#f59e0b", "dark");
      expect(s.background).toBe("rgba(245, 158, 11, 0.18)");
      expect(s.border).toBe("rgba(245, 158, 11, 0.35)");
      expect(s.foreground).toBe("#f59e0b");
    });
    it("falls back to a contrasting tone when contrast fails", () => {
      const s = tagChipStyles("#101010", "dark");
      // dark hex on dark theme is unreadable — should swap to light fallback
      expect(s.foreground).not.toBe("#101010");
    });
  });
});
