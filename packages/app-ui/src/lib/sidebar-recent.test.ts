import { expect, it } from 'vitest';
import { newestFirst } from './sidebar-recent';

const item = (id: string, createdAt: string) => ({ id, createdAt });
const ids = (rows: { id: string }[]) => rows.map(row => row.id);

// The sync lane hands rows back oldest-first, so slicing without sorting would pin the sidebar to
// the rows created longest ago and never surface a new one.
const rows = [
  item('a', '2026-01-01'),
  item('b', '2026-02-01'),
  item('c', '2026-03-01'),
  item('d', '2026-04-01'),
  item('e', '2026-05-01'),
  item('f', '2026-06-01'),
];

it('keeps the newest, newest first', () => {
  expect(ids(newestFirst(rows, 3))).toEqual(['f', 'e', 'd']);
});

it('shows everything when there is less than the limit', () => {
  expect(ids(newestFirst(rows.slice(0, 2), 5))).toEqual(['b', 'a']);
  expect(newestFirst([], 5)).toEqual([]);
});

// The property the whole "Show more" interaction rests on: a longer window is the shorter one plus
// rows underneath it, so nothing already on screen ever moves. This is why the current folder is no
// longer spliced in — an injected row sat out of order at the bottom, then jumped to its real place
// once the window grew past it, and every row after it shifted.
it('grows by appending, never by rearranging what is already shown', () => {
  const five = ids(newestFirst(rows, 5));
  const all = ids(newestFirst(rows, 6));
  expect(all.slice(0, five.length)).toEqual(five);
});

it('leaves the order alone whatever the caller is looking at', () => {
  // No keepIds parameter to pass any more: selection cannot change this list.
  expect(ids(newestFirst(rows, 3))).toEqual(['f', 'e', 'd']);
  expect(newestFirst(rows, 3)).toHaveLength(3);
});
