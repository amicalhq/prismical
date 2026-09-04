import { describe, expect, it } from "vitest";
import { TAG_PRESETS, nextAutoColor } from "./tag-colors";

describe("nextAutoColor", () => {
  it("returns the first preset when no tags exist", () => {
    expect(nextAutoColor([])).toBe(TAG_PRESETS[0]);
  });

  it("skips a preset that's already used and picks the next unused one", () => {
    expect(nextAutoColor([TAG_PRESETS[0]])).toBe(TAG_PRESETS[1]);
    expect(nextAutoColor([TAG_PRESETS[0], TAG_PRESETS[1]])).toBe(TAG_PRESETS[2]);
  });

  it("picks the least-used preset once every preset is taken", () => {
    // Every preset used once, plus an extra use of preset[0] -> preset[0] is now the
    // busiest, so the pick is the first still-tied-at-one preset (index 1).
    const colors = [...TAG_PRESETS, TAG_PRESETS[0]];
    expect(nextAutoColor(colors)).toBe(TAG_PRESETS[1]);
  });

  it("breaks ties toward the lowest index", () => {
    // All presets used equally (once each) -> tie -> lowest index wins.
    expect(nextAutoColor([...TAG_PRESETS])).toBe(TAG_PRESETS[0]);
  });

  it("ignores colors outside the preset set (e.g. legacy oklch seeds)", () => {
    expect(nextAutoColor(["oklch(0.7 0.1 250)", "#123456"])).toBe(TAG_PRESETS[0]);
  });
});
