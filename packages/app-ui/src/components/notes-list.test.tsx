// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { toNote } from '../../../app-client/src/api/adapters';
import { NotesList } from './notes-list';

vi.mock('@prismical/app-client', () => ({
  useNotes: () => ({
    data: [
      toNote({ id: 'old', title: 'Zulu', createdAt: '2026-01-01', updatedAt: '2026-03-01' }),
      toNote({ id: 'new', title: 'Alpha', createdAt: '2026-02-01', updatedAt: '2026-02-01' }),
    ],
  }),
  useAllNoteTags: () => ({ data: [] }),
}));
vi.mock('@prismical/app-i18n', () => ({ useApplicationLocale: () => ({ resolvedLocale: 'en' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./note-card', () => ({
  NoteCard: ({ note }: { note: { title: string } }) => <div data-testid="note">{note.title}</div>,
}));
afterEach(cleanup);
it.each([
  ['createdAt', 'asc', ['Zulu', 'Alpha']],
  ['createdAt', 'desc', ['Alpha', 'Zulu']],
  ['updatedAt', 'asc', ['Alpha', 'Zulu']],
  ['updatedAt', 'desc', ['Zulu', 'Alpha']],
  ['title', 'asc', ['Alpha', 'Zulu']],
  ['title', 'desc', ['Zulu', 'Alpha']],
] as const)('sorts by %s %s', (sortBy, sortOrder, expected) => {
  render(<NotesList showPageHeader={false} sortBy={sortBy} sortOrder={sortOrder} />);
  expect(screen.getAllByTestId('note').map(el => el.textContent)).toEqual(expected);
});
