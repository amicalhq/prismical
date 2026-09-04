import { describe, expect, it } from 'vitest';
import { SilenceWatcher, combinedSilentSeconds } from './index';

const RATE = 48_000;

function feed(w: SilenceWatcher, amplitude: number, seconds: number) {
  const frames = Math.round((seconds * RATE) / 480);
  for (let i = 0; i < frames; i++) {
    const f = new Float32Array(480);
    for (let j = 0; j < 480; j++) f[j] = j % 2 === 0 ? amplitude : -amplitude;
    w.push(f, RATE);
  }
}

describe('combinedSilentSeconds (desktop dual capture)', () => {
  it('is the shortest silent run — the most recently active lane wins', () => {
    const mic = new SilenceWatcher();
    const system = new SilenceWatcher();
    feed(mic, 0, 30);
    feed(system, 0, 30);
    feed(system, 0.4, 1); // something played on the system lane
    feed(system, 0, 2);
    expect(combinedSilentSeconds([mic, system])).toBeCloseTo(2, 0);
  });

  it('EXCLUDES a lane that never produced audio, rather than pinning the minimum at 0', () => {
    // A dual recording whose system lane never delivers a frame — no loopback device, permission
    // declined, nothing playing — otherwise held the combined figure at 0 forever, silently
    // disabling auto-pause on the platform where the waste is doubled.
    const mic = new SilenceWatcher();
    const system = new SilenceWatcher(); // never fed
    feed(mic, 0, 600);
    expect(combinedSilentSeconds([mic, system])).toBeCloseTo(600, 0);
  });

  it('is 0 when nothing has been captured at all', () => {
    expect(combinedSilentSeconds([])).toBe(0);
    expect(combinedSilentSeconds([new SilenceWatcher()])).toBe(0);
  });
});
