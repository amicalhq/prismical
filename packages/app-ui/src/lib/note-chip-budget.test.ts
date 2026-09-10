import { expect, it } from 'vitest';
import { chipBudget } from './note-chip-budget';

/** The wide chips the row draws; the counters are narrow and not charged to the budget. */
function slots(hasFolder: boolean, meetings: number, tags: number): number {
  const shown = chipBudget(hasFolder, meetings, tags);
  return (hasFolder ? 1 : 0) + shown.events + shown.tags;
}

// A note is usually about one meeting, so the extras are counted and the width goes to tags.
it('shows one meeting and counts the rest', () => {
  expect(chipBudget(false, 5, 4)).toEqual({ events: 1, tags: 4 });
  expect(chipBudget(true, 5, 4)).toEqual({ events: 1, tags: 3 });
});

// The meeting counter is narrow, so it does not come out of the tags' share.
it('does not charge the tags for the meetings it hid', () => {
  expect(chipBudget(true, 1, 9).tags).toBe(chipBudget(true, 4, 9).tags);
});

it('gives the tags every slot the folder and meeting leave', () => {
  expect(chipBudget(false, 1, 9)).toEqual({ events: 1, tags: 4 });
  expect(chipBudget(true, 1, 9)).toEqual({ events: 1, tags: 3 });
});

it('gives the whole line to tags when there is no meeting', () => {
  expect(chipBudget(false, 0, 5)).toEqual({ events: 0, tags: 5 });
  expect(chipBudget(false, 0, 9)).toEqual({ events: 0, tags: 5 });
  expect(chipBudget(true, 0, 9)).toEqual({ events: 0, tags: 4 });
});

it('shows everything that fits without a counter', () => {
  expect(chipBudget(false, 1, 3)).toEqual({ events: 1, tags: 3 });
  expect(chipBudget(false, 0, 0)).toEqual({ events: 0, tags: 0 });
  expect(chipBudget(true, 1, 0)).toEqual({ events: 1, tags: 0 });
});

// A meeting always keeps its chip, however many tags the note carries.
it('never drops the meeting for tags', () => {
  expect(chipBudget(false, 1, 20)).toEqual({ events: 1, tags: 4 });
  expect(chipBudget(true, 3, 20)).toEqual({ events: 1, tags: 3 });
});

it('never draws more wide chips than the budget', () => {
  for (const folder of [false, true]) {
    for (let meetings = 0; meetings <= 12; meetings += 1) {
      for (let tags = 0; tags <= 12; tags += 1) {
        const shown = chipBudget(folder, meetings, tags);
        expect(slots(folder, meetings, tags), `${folder} ${meetings} ${tags}`).toBeLessThanOrEqual(
          5
        );
        expect(shown.events).toBeLessThanOrEqual(meetings);
        expect(shown.tags).toBeLessThanOrEqual(tags);
        expect(shown.tags).toBeGreaterThanOrEqual(0);
        // A note that has a meeting always shows one.
        if (meetings > 0) expect(shown.events).toBe(1);
      }
    }
  }
});
