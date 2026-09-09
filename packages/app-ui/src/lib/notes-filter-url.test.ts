import { expect, it } from 'vitest';
import { withoutNotesFilter } from './notes-filter-url';

it('removes only the deleted tag and preserves folder and sorting', () => {
  expect(
    withoutNotesFilter(
      new URLSearchParams('folder=fld_a&tags=tag_a&tags=tag_b&sort=title&sortOrder=asc'),
      'tags',
      'tag_a'
    )
  ).toBe('/notes?folder=fld_a&tags=tag_b&sort=title&sortOrder=asc');
});
it('removes only the deleted folder', () => {
  expect(
    withoutNotesFilter(
      new URLSearchParams('folder=fld_a&tags=tag_b&sort=createdAt&sortOrder=desc'),
      'folder',
      'fld_a'
    )
  ).toBe('/notes?tags=tag_b&sort=createdAt&sortOrder=desc');
});
it('returns the notes route when the last filter is removed', () => {
  expect(withoutNotesFilter(new URLSearchParams('tags=tag_a'), 'tags', 'tag_a')).toBe('/notes');
});
