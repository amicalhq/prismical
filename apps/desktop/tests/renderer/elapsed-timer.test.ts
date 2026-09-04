/**
 * formatElapsed — the pure timer formatting the dock pill
 * renders off `startedAt + pausedAccumMs`. m:ss under an hour, h:mm:ss beyond,
 * clamped at zero (negative clock skew never renders a negative timer).
 */
import { describe, expect, it } from 'vitest';
import { formatElapsed } from '../../src/renderer/widget/elapsed-timer';

describe('formatElapsed', () => {
  it('renders m:ss under an hour', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(59_000)).toBe('0:59');
    expect(formatElapsed(60_000)).toBe('1:00');
    expect(formatElapsed(754_000)).toBe('12:34');
    expect(formatElapsed(3_599_000)).toBe('59:59');
  });

  it('renders h:mm:ss from an hour up', () => {
    expect(formatElapsed(3_600_000)).toBe('1:00:00');
    expect(formatElapsed(3_661_000)).toBe('1:01:01');
    expect(formatElapsed(36_000_000 + 754_000)).toBe('10:12:34');
  });

  it('clamps negatives (clock skew) and truncates sub-second remainders', () => {
    expect(formatElapsed(-5_000)).toBe('0:00');
    expect(formatElapsed(999)).toBe('0:00');
    expect(formatElapsed(1_999)).toBe('0:01');
  });
});
