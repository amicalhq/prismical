import { describe, expect, it } from "vitest";
import {
  TAG_AUTO_ASSIGN_ORDER,
  TAG_PRESETS,
  isHexColor,
  nextAutoColor,
  normalizeHexColor,
  swatchInk,
} from "./tag-colors";

describe("palette", () => {
  it("assigns from a permutation of the displayed presets", () => {
    expect([...TAG_AUTO_ASSIGN_ORDER].sort()).toEqual([...TAG_PRESETS].sort());
  });

  it("has no duplicate swatches", () => {
    expect(new Set(TAG_PRESETS).size).toBe(TAG_PRESETS.length);
  });
});

describe("nextAutoColor", () => {
  it("returns the first color in the assignment order when no tags exist", () => {
    expect(nextAutoColor([])).toBe(TAG_AUTO_ASSIGN_ORDER[0]);
  });

  it("skips a preset that's already used and picks the next unused one", () => {
    expect(nextAutoColor([TAG_AUTO_ASSIGN_ORDER[0]])).toBe(TAG_AUTO_ASSIGN_ORDER[1]);
    expect(nextAutoColor([TAG_AUTO_ASSIGN_ORDER[0], TAG_AUTO_ASSIGN_ORDER[1]])).toBe(
      TAG_AUTO_ASSIGN_ORDER[2],
    );
  });

  it("picks the least-used preset once every preset is taken", () => {
    // Every preset used once, plus an extra use of the first one -> that one is now the busiest, so
    // the pick is the first still-tied-at-one preset (index 1).
    const colors = [...TAG_AUTO_ASSIGN_ORDER, TAG_AUTO_ASSIGN_ORDER[0]];
    expect(nextAutoColor(colors)).toBe(TAG_AUTO_ASSIGN_ORDER[1]);
  });

  it("breaks ties toward the earliest color in the assignment order", () => {
    // All presets used equally (once each) -> tie -> earliest wins.
    expect(nextAutoColor([...TAG_AUTO_ASSIGN_ORDER])).toBe(TAG_AUTO_ASSIGN_ORDER[0]);
  });

  it("ignores colors outside the preset set (e.g. legacy oklch seeds, custom picks)", () => {
    expect(nextAutoColor(["oklch(0.7 0.1 250)", "#123456"])).toBe(TAG_AUTO_ASSIGN_ORDER[0]);
  });
});

describe("hex helpers", () => {
  it("accepts 3- and 6-digit hex and rejects anything else", () => {
    expect(isHexColor("#abc")).toBe(true);
    expect(isHexColor("#AABBCC")).toBe(true);
    expect(isHexColor("aabbcc")).toBe(false);
    expect(isHexColor("#abcd")).toBe(false);
    expect(isHexColor("oklch(0.7 0.1 250)")).toBe(false);
  });

  it("expands and lowercases so hand-typed and picker values compare equal", () => {
    expect(normalizeHexColor("#ABC")).toBe("#aabbcc");
    expect(normalizeHexColor(" #F59E0B ")).toBe("#f59e0b");
    expect(normalizeHexColor("nope")).toBeNull();
  });

  it("puts dark ink on light swatches and light ink on dark ones", () => {
    expect(swatchInk("#facc15")).toBe("#000000");
    expect(swatchInk("#a3e635")).toBe("#000000");
    expect(swatchInk("#ef4444")).toBe("#ffffff");
    expect(swatchInk("#000000")).toBe("#ffffff");
    // An unmeasurable (non-hex) color keeps the previous white checkmark.
    expect(swatchInk("oklch(0.7 0.1 250)")).toBe("#ffffff");
  });
});
