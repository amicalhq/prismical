import { describe, expect, it } from 'vitest';
import {
  SYSTEM_AUDIO_MIN_MAJOR,
  SYSTEM_AUDIO_MIN_MINOR,
  meetsMinimumVersion,
} from '../../src/main/domains/recording/permission/policy';

/** The system-audio floor: macOS 14.2. */
const meets14_2 = (v: string): boolean =>
  meetsMinimumVersion(v, SYSTEM_AUDIO_MIN_MAJOR, SYSTEM_AUDIO_MIN_MINOR);

describe('meetsMinimumVersion (system-audio ≥ 14.2 gate)', () => {
  it('accepts exactly the floor and above', () => {
    expect(meets14_2('14.2')).toBe(true);
    expect(meets14_2('14.2.0')).toBe(true);
    expect(meets14_2('14.2.1')).toBe(true);
    expect(meets14_2('14.5')).toBe(true);
    expect(meets14_2('14.10.3')).toBe(true); // minor 10 > 2 (numeric, not lexical)
    expect(meets14_2('15.0')).toBe(true);
    expect(meets14_2('26.1')).toBe(true);
  });

  it('rejects below the floor', () => {
    expect(meets14_2('14.1')).toBe(false);
    expect(meets14_2('14.1.9')).toBe(false);
    expect(meets14_2('14.0')).toBe(false);
    expect(meets14_2('13.9')).toBe(false);
    expect(meets14_2('10.15.7')).toBe(false);
  });

  it('fails CLOSED on an unparseable version', () => {
    expect(meets14_2('')).toBe(false);
    expect(meets14_2('sonoma')).toBe(false);
    expect(meets14_2('..')).toBe(false);
  });

  it('treats a missing minor as .0', () => {
    expect(meetsMinimumVersion('14', 14, 2)).toBe(false);
    expect(meetsMinimumVersion('15', 14, 2)).toBe(true);
  });
});
