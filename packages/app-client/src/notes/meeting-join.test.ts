import { describe, expect, it } from 'vitest';
import { JOIN_RECORDING_LEAD_MS, recordsOnJoin } from './meeting-join';

const start = new Date('2026-10-21T15:00:00Z');
const end = new Date('2026-10-21T15:30:00Z');

describe('recordsOnJoin', () => {
  it('records a meeting that is under way', () => {
    expect(recordsOnJoin(start, end, false, start.getTime() + 60_000)).toBe(true);
  });

  it('records a meeting that starts within the lead window', () => {
    expect(recordsOnJoin(start, end, false, start.getTime() - JOIN_RECORDING_LEAD_MS)).toBe(true);
  });

  it('does not record a meeting further out than the lead window', () => {
    expect(recordsOnJoin(start, end, false, start.getTime() - JOIN_RECORDING_LEAD_MS - 1)).toBe(false);
  });

  it('does not record a meeting that has ended', () => {
    expect(recordsOnJoin(start, end, false, end.getTime())).toBe(false);
  });

  it('accepts ISO strings', () => {
    expect(recordsOnJoin(start.toISOString(), end.toISOString(), false, start.getTime())).toBe(true);
  });

  it('never records an all-day event, even while it is under way', () => {
    expect(recordsOnJoin(start, end, true, start.getTime() + 60_000)).toBe(false);
  });

  it('does not record when a time is unparseable', () => {
    expect(recordsOnJoin('not a date', end, false, start.getTime())).toBe(false);
  });
});
