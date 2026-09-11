import { expect, it } from 'vitest';
import { meetingBudget, tagBudget } from './note-chip-budget';

// Tags share the title line with the note's own name, so the line takes what fits and counts the
// rest.
it('draws a few tags beside the title and counts the rest', () => {
  expect(tagBudget(0)).toBe(0);
  expect(tagBudget(2)).toBe(2);
  expect(tagBudget(3)).toBe(3);
  expect(tagBudget(9)).toBe(3);
});

// A note is usually about one meeting, and a meeting chip is wide enough to carry a whole invite
// title, so the extras become a counter.
it('shows one meeting and counts the rest', () => {
  expect(meetingBudget(0)).toBe(0);
  expect(meetingBudget(1)).toBe(1);
  expect(meetingBudget(5)).toBe(1);
});

it('never draws a chip the note does not have', () => {
  for (let n = 0; n <= 12; n += 1) {
    expect(tagBudget(n)).toBeLessThanOrEqual(n);
    expect(tagBudget(n)).toBeGreaterThanOrEqual(0);
    expect(meetingBudget(n)).toBeLessThanOrEqual(n);
    expect(meetingBudget(n)).toBeGreaterThanOrEqual(0);
  }
});
