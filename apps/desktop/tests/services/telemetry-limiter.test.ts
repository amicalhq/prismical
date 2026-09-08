import { describe, expect, it } from 'vitest';
import { makeExceptionLimiter } from '../../src/main/domains/telemetry/exception-limiter';

describe('exception suppression', () => {
  it('limits each fingerprint independently and replenishes after a minute', () => {
    const limiter = makeExceptionLimiter();
    const error = Object.assign(new Error('safe'), { frames: [] });
    expect([0, 1, 2, 3].map(() => limiter.admit(error, 'main', 0))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(limiter.admit(error, 'renderer', 0)).toBe(true);
    expect(limiter.admit(error, 'main', 60_000)).toBe(true);
    limiter.clear();
    expect(limiter.admit(error, 'main', 60_001)).toBe(true);
  });
  it('keeps different originating source frames in separate buckets', () => {
    const limiter = makeExceptionLimiter();
    const error = Object.assign(new Error('safe'), {
      frames: [{ filename: 'index.js', lineno: 1, colno: 2 }],
    });
    for (let i = 0; i < 3; i++) limiter.admit(error, 'renderer', 0);
    expect(limiter.admit(error, 'renderer', 0)).toBe(false);
    error.frames[0]!.lineno = 2;
    expect(limiter.admit(error, 'renderer', 0)).toBe(true);
  });
  it('evicts the oldest fingerprint at its memory bound', () => {
    const limiter = makeExceptionLimiter();
    const error = Object.assign(new Error('safe'), { frames: [] });
    for (let i = 0; i < 3; i++) limiter.admit(error, 'old', 0);
    for (let i = 0; i < 128; i++) limiter.admit(error, `source-${i}`, 0);
    expect(limiter.admit(error, 'old', 1)).toBe(true);
  });
});
