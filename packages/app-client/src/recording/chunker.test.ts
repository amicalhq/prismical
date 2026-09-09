import { describe, it, expect } from 'vitest';
import { ChunkBoundaryPicker, defaultChunkerProfile, type ChunkerProfile } from './chunker';

const RATE = 16000;
const loud = (n: number) => new Float32Array(n).fill(0.4);
const quiet = (n: number) => new Float32Array(n); // zeros

// The code defaults (env-overridable in the web build).
const PROFILE = defaultChunkerProfile();

describe('ChunkBoundaryPicker initial context', () => {
  it('waits for four seconds even when the first audio is quiet', () => {
    const p = new ChunkBoundaryPicker(RATE, PROFILE);
    expect(p.push(quiet(3 * RATE))).toBeNull();
    const chunk = p.push(quiet(RATE));
    expect(chunk).toHaveLength(4 * RATE);
  });

  it('caps the first chunk at six seconds during continuous speech', () => {
    const p = new ChunkBoundaryPicker(RATE, PROFILE);
    expect(p.push(loud(5 * RATE))).toBeNull();
    expect(p.push(loud(RATE))).toHaveLength(6 * RATE);
  });

  it('keeps four seconds of context in subsequent chunks', () => {
    const p = new ChunkBoundaryPicker(RATE, PROFILE);
    expect(p.push(quiet(4 * RATE))).toHaveLength(4 * RATE);
    expect(p.push(quiet(3 * RATE))).toBeNull();
    expect(p.push(quiet(RATE))).toHaveLength(4 * RATE);
  });

  it('lets the second chunk reach fifteen seconds without a pause', () => {
    const p = new ChunkBoundaryPicker(RATE, PROFILE);
    expect(p.push(quiet(4 * RATE))).toHaveLength(4 * RATE);
    expect(p.push(loud(6 * RATE))).toBeNull();
    expect(p.push(loud(8 * RATE))).toBeNull();
    expect(p.push(loud(RATE))).toHaveLength(15 * RATE);
  });

  it('retains short recordings when stopped before the minimum', () => {
    const p = new ChunkBoundaryPicker(RATE, PROFILE);
    expect(p.push(loud(RATE))).toBeNull();
    expect(p.flush()).toHaveLength(RATE);
    expect(p.flush()).toBeNull();
  });
});

describe('ChunkBoundaryPicker steady state', () => {
  // A profile with no warm-up isolates the steady behavior (the pre-ramp contract).
  const steady: ChunkerProfile = { warmupWindowS: 0, warmupMinS: 3, steadyMinS: 3, maxS: 15 };

  it('does not cut before the minimum chunk length', () => {
    const p = new ChunkBoundaryPicker(RATE, steady);
    // 2.5s of silence — under the 3s minimum, even though it's all quiet.
    for (let i = 0; i < 2.5 * (RATE / 512); i++) expect(p.push(quiet(512))).toBeNull();
  });

  it('cuts at a quiet window once past the minimum', () => {
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

  it('force-cuts at the maximum length even without silence', () => {
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

  it('flush() returns whatever remains', () => {
    const p = new ChunkBoundaryPicker(RATE, steady);
    p.push(loud(512));
    const rest = p.flush();
    expect(rest).not.toBeNull();
    expect(rest!.length).toBe(512);
    expect(p.flush()).toBeNull(); // nothing left
  });
});
