import { describe, it, expect } from "vitest";
import { ChunkBoundaryPicker, type ChunkerProfile } from "./chunker";

const RATE = 16000;
const loud = (n: number) => new Float32Array(n).fill(0.4);
const quiet = (n: number) => new Float32Array(n); // zeros

// The code defaults (env-overridable in the web build).
const PROFILE: ChunkerProfile = { warmupWindowS: 10, warmupMinS: 1, steadyMinS: 3, maxS: 15 };

/** Push up to `seconds` of frames, returning the first cut chunk (and how long it took). */
function pushUntilCut(
  p: ChunkBoundaryPicker,
  frame: () => Float32Array,
  seconds: number
): { chunk: Float32Array | null; pushedFrames: number } {
  let chunk: Float32Array | null = null;
  let pushedFrames = 0;
  const frames = Math.ceil(seconds * (RATE / 512));
  while (!chunk && pushedFrames < frames) {
    chunk = p.push(frame());
    pushedFrames++;
  }
  return { chunk, pushedFrames };
}

describe("ChunkBoundaryPicker warm-up ramp", () => {
  it("cuts the FIRST chunk at ~1s when quiet (fast first transcript line)", () => {
    const p = new ChunkBoundaryPicker(RATE, PROFILE);
    const { chunk } = pushUntilCut(p, () => quiet(512), 3);
    expect(chunk).not.toBeNull();
    expect(chunk!.length).toBeGreaterThanOrEqual(1 * RATE);
    expect(chunk!.length).toBeLessThan(1.5 * RATE);
  });

  it("hard-cuts the first chunk at min+2s even through continuous speech", () => {
    const p = new ChunkBoundaryPicker(RATE, PROFILE);
    const { chunk } = pushUntilCut(p, () => loud(512), 5);
    expect(chunk).not.toBeNull();
    // warm-up cap = warmupMinS + 2 = 3s, never the steady 15s force-cut
    expect(chunk!.length).toBeLessThanOrEqual(3 * RATE + 512);
  });

  it("ramps the minimum per chunk: ~1s, ~2s, then the steady 3s", () => {
    const p = new ChunkBoundaryPicker(RATE, PROFILE);
    const first = pushUntilCut(p, () => quiet(512), 3).chunk;
    const second = pushUntilCut(p, () => quiet(512), 4).chunk;
    const third = pushUntilCut(p, () => quiet(512), 5).chunk;
    expect(first!.length).toBeGreaterThanOrEqual(1 * RATE);
    expect(first!.length).toBeLessThan(2 * RATE);
    expect(second!.length).toBeGreaterThanOrEqual(2 * RATE);
    expect(second!.length).toBeLessThan(3 * RATE);
    expect(third!.length).toBeGreaterThanOrEqual(3 * RATE);
  });

  it("uses the steady minimum once past the warm-up window", () => {
    const p = new ChunkBoundaryPicker(RATE, PROFILE);
    // Consume the 10s warm-up window (loud audio, letting warm-up chunks cut as they will).
    for (let i = 0; i < 11 * (RATE / 512); i++) p.push(loud(512));
    p.flush(); // start the next chunk clean, past the window
    const { chunk } = pushUntilCut(p, () => quiet(512), 5);
    expect(chunk).not.toBeNull();
    expect(chunk!.length).toBeGreaterThanOrEqual(3 * RATE);
  });
});

describe("ChunkBoundaryPicker steady state", () => {
  // A profile with no warm-up isolates the steady behavior (the pre-ramp contract).
  const steady: ChunkerProfile = { warmupWindowS: 0, warmupMinS: 3, steadyMinS: 3, maxS: 15 };

  it("does not cut before the minimum chunk length", () => {
    const p = new ChunkBoundaryPicker(RATE, steady);
    // 2.5s of silence — under the 3s minimum, even though it's all quiet.
    for (let i = 0; i < 2.5 * (RATE / 512); i++) expect(p.push(quiet(512))).toBeNull();
  });

  it("cuts at a quiet window once past the minimum", () => {
    const p = new ChunkBoundaryPicker(RATE, steady);
    let chunk: Float32Array | null = null;
    // 6s loud speech — no cut while loud…
    for (let i = 0; i < 6 * (RATE / 512) && !chunk; i++) chunk = p.push(loud(512));
    expect(chunk).toBeNull();
    // …then silence — should cut shortly into it.
    for (let i = 0; i < 2 * (RATE / 512) && !chunk; i++) chunk = p.push(quiet(512));
    expect(chunk).not.toBeNull();
    expect(chunk!.length).toBeGreaterThanOrEqual(6 * RATE);
  });

  it("force-cuts at the maximum length even without silence", () => {
    const p = new ChunkBoundaryPicker(RATE, steady);
    let chunk: Float32Array | null = null;
    let frames = 0;
    while (!chunk && frames < 16 * (RATE / 512)) {
      chunk = p.push(loud(512));
      frames++;
    }
    expect(chunk).not.toBeNull();
    expect(chunk!.length).toBeLessThanOrEqual(15 * RATE + 512);
  });

  it("flush() returns whatever remains", () => {
    const p = new ChunkBoundaryPicker(RATE, steady);
    p.push(loud(512));
    const rest = p.flush();
    expect(rest).not.toBeNull();
    expect(rest!.length).toBe(512);
    expect(p.flush()).toBeNull(); // nothing left
  });
});
