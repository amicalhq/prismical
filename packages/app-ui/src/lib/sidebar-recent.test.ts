import { expect, it } from 'vitest';
import { recentPlusCurrent } from './sidebar-recent';

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
  expect(ids(recentPlusCurrent(rows, 3, []))).toEqual(['f', 'e', 'd']);
});

it('shows everything when there is less than the limit', () => {
  expect(ids(recentPlusCurrent(rows.slice(0, 2), 5, []))).toEqual(['b', 'a']);
  expect(recentPlusCurrent([], 5, [])).toEqual([]);
});

// Without this the sidebar silently stops being able to say where you are: the row it would mark
// active is the one the cap dropped.
it('keeps where the user is, however old it is', () => {
  expect(ids(recentPlusCurrent(rows, 3, ['a']))).toEqual(['f', 'e', 'd', 'a']);
  expect(ids(recentPlusCurrent(rows, 3, ['a', 'b']))).toEqual(['f', 'e', 'd', 'a', 'b']);
});

it('never lists the current one twice', () => {
  expect(ids(recentPlusCurrent(rows, 3, ['e']))).toEqual(['f', 'e', 'd']);
});

it('ignores an id that has no row, and a null one', () => {
  expect(ids(recentPlusCurrent(rows, 3, ['gone', null, undefined]))).toEqual(['f', 'e', 'd']);
});
