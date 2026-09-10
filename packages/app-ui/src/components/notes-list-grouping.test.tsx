// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NotesList } from './notes-list';

const state = vi.hoisted(() => ({
  notes: [] as { id: string; title: string; updatedAt: string; createdAt?: string; tagIds: string[] }[],
}));

vi.mock('@prismical/app-client', () => ({
  useNotes: () => ({ data: state.notes, isLoading: false }),
  useAllNoteTags: () => ({ data: [], isLoading: false }),
}));
vi.mock('@prismical/app-i18n', () => ({ useApplicationLocale: () => ({ resolvedLocale: 'en' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./note-card', () => ({
  NoteCard: ({ note }: { note: { title: string } }) => <div data-testid="note">{note.title}</div>,
}));

const note = (id: string, updatedAt: Date) => ({
  id,
  title: id,
  updatedAt: updatedAt.toISOString(),
  tagIds: [],
});

/** Section headings in render order. */
function headings(): string[] {
  return screen.getAllByRole('heading', { level: 2 }).map(el => el.textContent ?? '');
}

beforeEach(() => {
  state.notes = [];
});
afterEach(cleanup);

// The empty state is the whole answer — no date heading stands over nothing.
it('shows the empty card and no headings when there are no notes', () => {
  render(<NotesList showPageHeader={false} groupByDate />);
  expect(screen.getByText('notes.list.emptyTitle')).toBeTruthy();
  expect(screen.queryAllByRole('heading', { level: 2 })).toEqual([]);
});

it('heads a single note with its own bucket', () => {
  state.notes = [note('only', new Date())];
  render(<NotesList showPageHeader={false} groupByDate />);
  expect(headings()).toEqual(['notes.list.today']);
});

it('opens a heading per bucket that holds notes', () => {
  const now = new Date();
  const daysAgo = (days: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 12);
  state.notes = [note('today', now), note('yesterday', daysAgo(1))];
  render(<NotesList showPageHeader={false} groupByDate />);
  expect(headings()).toEqual(['notes.list.today', 'common.time.yesterday']);
});

// Headings follow a date order; over a title sort they would interleave and repeat.
it('drops the headings for a title sort', () => {
  state.notes = [note('b', new Date()), note('a', new Date(2024, 0, 2))];
  render(<NotesList showPageHeader={false} groupByDate sortBy="title" sortOrder="asc" />);
  expect(screen.queryAllByRole('heading', { level: 2 })).toEqual([]);
  // Ordered by title, so the buckets they belong to are interleaved and headings would repeat.
  expect(screen.getAllByTestId('note').map(el => el.textContent)).toEqual(['a', 'b']);
});


it('groups by creation date when that is the selected sort', () => {
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
  state.notes = [
    { ...note('edited today', now), createdAt: yesterday.toISOString() },
    note('optimistic note without a creation date', now),
  ];
  render(<NotesList showPageHeader={false} groupByDate sortBy="createdAt" />);
  expect(headings()).toEqual(['notes.list.today', 'common.time.yesterday']);
  expect(screen.getAllByTestId('note').map(el => el.textContent)).toEqual([
    'optimistic note without a creation date',
    'edited today',
  ]);
});
