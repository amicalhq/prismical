// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NotesList } from './notes-list';

const state = vi.hoisted(() => ({
  links: {
    data: [] as { noteId: string; tagId: string }[],
    isLoading: false,
    error: undefined as Error | undefined,
    refetch: vi.fn(),
  },
}));
vi.mock('@prismical/app-client', () => ({
  useNotes: () => ({
    data: [
      { id: 'parent', title: 'Zulu', folderId: 'fld_parent', updatedAt: '2026-01-01', tagIds: [] },
      { id: 'child', title: 'Alpha', folderId: 'fld_child', updatedAt: '2026-02-01', tagIds: [] },
      { id: 'other', title: 'Other', folderId: 'fld_other', updatedAt: '2026-03-01', tagIds: [] },
    ],
    isLoading: false,
  }),
  useAllNoteTags: () => state.links,
}));
vi.mock('@prismical/app-i18n', () => ({ useApplicationLocale: () => ({ resolvedLocale: 'en' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./note-card', () => ({
  NoteCard: ({ note }: { note: { title: string } }) => <div data-testid="note">{note.title}</div>,
}));
vi.mock('./skeletons', () => ({
  NoteListSkeleton: () => <div role="status">Loading</div>,
  NoteGroupsSkeleton: () => <div role="status">Loading</div>,
}));
beforeEach(() => {
  state.links.isLoading = false;
  state.links.error = undefined;
  state.links.data = [
    { noteId: 'parent', tagId: 'tag_a' },
    { noteId: 'child', tagId: 'tag_a' },
    { noteId: 'child', tagId: 'tag_b' },
    { noteId: 'other', tagId: 'tag_a' },
    { noteId: 'other', tagId: 'tag_b' },
  ];
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('combines descendant folder membership with ALL selected tags', () => {
  render(<NotesList folderIds={['fld_parent', 'fld_child']} tagIds={['tag_a', 'tag_b']} />);
  expect(screen.getAllByTestId('note').map(el => el.textContent)).toEqual(['Alpha']);
});
it('sorts the filtered folder/tag result', () => {
  render(
    <NotesList
      folderIds={['fld_parent', 'fld_child']}
      tagIds={['tag_a']}
      sortBy="title"
      sortOrder="asc"
    />
  );
  expect(screen.getAllByTestId('note').map(el => el.textContent)).toEqual(['Alpha', 'Zulu']);
});
it('waits for tag links instead of showing a false empty result', () => {
  state.links.data = [];
  state.links.isLoading = true;
  render(<NotesList tagIds={['tag_a']} />);
  expect(screen.getByRole('status').textContent).toBe('Loading');
  expect(screen.queryByText('notes.list.emptyTitle')).toBeNull();
});
it('offers retry for failed tag links', () => {
  state.links.data = [];
  state.links.error = new Error('offline');
  render(<NotesList tagIds={['tag_a']} />);
  expect(screen.getByRole('alert')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'common.actions.retry' }));
  expect(state.links.refetch).toHaveBeenCalledOnce();
});
it('keeps unfiltered notes available when tag links fail', () => {
  state.links.error = new Error('offline');
  render(<NotesList />);
  expect(screen.getAllByTestId('note')).toHaveLength(3);
  expect(screen.queryByRole('alert')).toBeNull();
});
