import { describe, it, expect } from 'vitest';
import {
  chunkSegmentValues,
  countWords,
  SEGMENT_ORDER_WINDOW,
  SEGMENT_ORDER_CLOUD_BASE,
  segmentOrderRange,
} from './segments.js';

const ctx = {
  recordingId: 'rec_x',
  orgUserId: 'ou_x',
  chunkIndex: 3,
  chunkStartMs: 30000,
  source: 'mic',
  durationMs: 10000,
};

describe('chunkSegmentValues', () => {
  it('maps a transcribed chunk to one segment row', () => {
    const rows = chunkSegmentValues('Hello world.', ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recordingId: 'rec_x',
      orgUserId: 'ou_x',
      source: 'mic',
      speaker: 'you',
      text: 'Hello world.',
      startTimeMs: 30000,
      endTimeMs: 40000,
      segmentOrder: SEGMENT_ORDER_CLOUD_BASE + 3 * SEGMENT_ORDER_WINDOW,
      isFinal: true,
    });
  });

  it('attributes system-audio chunks to the other party (speaker "them")', () => {
    const rows = chunkSegmentValues('Hello from the call.', { ...ctx, source: 'system' });
    expect(rows[0]).toMatchObject({ source: 'system', speaker: 'them' });
  });

  it('attributes mic chunks to the local user (speaker "you")', () => {
    const rows = chunkSegmentValues('Hello from me.', { ...ctx, source: 'mic' });
    expect(rows[0]).toMatchObject({ source: 'mic', speaker: 'you' });
  });

  it('returns no rows for empty/whitespace transcripts (silence)', () => {
    expect(chunkSegmentValues('', ctx)).toHaveLength(0);
    expect(chunkSegmentValues('   \n', ctx)).toHaveLength(0);
  });

  it('trims surrounding whitespace from the text', () => {
    expect(chunkSegmentValues('  hi there  ', ctx)[0]?.text).toBe('hi there');
  });
});

describe('segmentOrderRange', () => {
  it('returns the [start, end] window for a chunk index, offset by the cloud base', () => {
    expect(segmentOrderRange(0)).toEqual([SEGMENT_ORDER_CLOUD_BASE, SEGMENT_ORDER_CLOUD_BASE + SEGMENT_ORDER_WINDOW - 1]);
    expect(segmentOrderRange(2)).toEqual([
      SEGMENT_ORDER_CLOUD_BASE + 2 * SEGMENT_ORDER_WINDOW,
      SEGMENT_ORDER_CLOUD_BASE + 3 * SEGMENT_ORDER_WINDOW - 1,
    ]);
  });

  it('never overlaps the desktop sequential-order space (0,1,2,…)', () => {
    expect(segmentOrderRange(0)[0]).toBeGreaterThan(100_000);
  });
});

describe('countWords', () => {
  it('counts whitespace-separated words', () => {
    expect(countWords('Hello world, this is four')).toBe(5);
    expect(countWords('')).toBe(0);
    expect(countWords('  one  ')).toBe(1);
  });
});
