import { expect, it } from 'vitest';
import { withNotesFolder, withoutNotesFilter } from './notes-filter-url';

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

it('switches the folder and keeps the other filters', () => {
  expect(
    withNotesFolder(new URLSearchParams('folder=fld_a&tags=tag_a&sort=title'), 'fld_b')
  ).toBe('/notes?folder=fld_b&tags=tag_a&sort=title');
});
it('drops the folder for the root view and keeps the rest', () => {
  expect(withNotesFolder(new URLSearchParams('folder=fld_a&tags=tag_a'), null)).toBe(
    '/notes?tags=tag_a'
  );
  expect(withNotesFolder(new URLSearchParams('folder=fld_a'), null)).toBe('/notes');
});
it('adds a folder to an unfiltered view', () => {
  expect(withNotesFolder(new URLSearchParams(''), 'fld_a')).toBe('/notes?folder=fld_a');
});
