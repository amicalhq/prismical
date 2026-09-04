import { describe, it, expect } from 'vitest';
import { segmentClockLabel, speakerLabel } from './transcripts';

// Timestamps render in the viewer's zone, so these assert the shape + the offset math rather than a
// fixed string (the suite must pass in any TZ).
describe('segmentClockLabel', () => {
  const started = '2026-07-13T09:00:00.000Z';

  /** Minutes since the top of the 12-hour cycle — comparable across any UTC offset, incl. :30 zones. */
  const minutesOnDial = (label: string) => {
    const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(label);
    expect(m).not.toBeNull();
    return (Number(m![1]) % 12) * 60 + Number(m![2]);
  };

  it('renders a 12-hour clock time', () => {
    expect(segmentClockLabel(started, 0)).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });

  it("offsets from the recording's start", () => {
    const elapsed =
      minutesOnDial(segmentClockLabel(started, 90 * 60_000)) -
      minutesOnDial(segmentClockLabel(started, 0));
    expect(((elapsed % 720) + 720) % 720).toBe(90);
  });

  it('falls back to the raw offset when the recording has no start time', () => {
    expect(segmentClockLabel(null, 187_000)).toBe('03:07');
    expect(segmentClockLabel('not-a-date', 187_000)).toBe('03:07');
  });

  it("uses the selected interface locale's clock convention", () => {
    expect(segmentClockLabel(started, 0, 'de')).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('speakerLabel', () => {
  const labels = {
    you: 'Du',
    them: 'Gegenüber',
    speaker: 'Sprecher',
    speakerNumber: (number: number) => `Sprecher ${number}`,
  };

  it('uses localized generated speaker labels while preserving explicit renames', () => {
    expect(speakerLabel('you', undefined, labels)).toBe('Du');
    expect(speakerLabel('them', undefined, labels)).toBe('Gegenüber');
    expect(speakerLabel('dz:1', undefined, labels)).toBe('Sprecher 2');
    expect(speakerLabel('dz:not-a-number', undefined, labels)).toBe('Sprecher');
    expect(speakerLabel('dz:1', new Map([['dz:1', 'Ada']]), labels)).toBe('Ada');
  });
});
