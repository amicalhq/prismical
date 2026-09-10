// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { NotesScreen } from './notes-screen';

const state = vi.hoisted(() => ({
  search: new URLSearchParams(),
  tags: { data: [] as { id: string; name: string; color: string }[], isSuccess: true },
  replace: vi.fn(),
  listProps: undefined as { tagIds?: string[] } | undefined,
}));

vi.mock('@prismical/app-client', () => ({
  useSearchParams: () => state.search,
  useNavigation: () => ({ push: vi.fn(), replace: state.replace, back: vi.fn() }),
  useFolders: () => ({ data: [] }),
  folderSubtreeIds: () => [],
  useTags: () => state.tags,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../shell/command-palette', () => ({ useCommandPalette: () => ({ setOpen: vi.fn() }) }));
vi.mock('../shell/shortcut-hint', () => ({ ShortcutHint: () => null }));
vi.mock('../components/notes-folder-picker', () => ({ NotesFolderPicker: () => null }));
vi.mock('../components/notes-tag-filter', () => ({
  NotesTagFilter: ({ selected }: { selected: string[] }) => (
    <div data-testid="filter">{selected.join(',')}</div>
  ),
}));
vi.mock('../components/notes-list', () => ({
  NotesList: (props: { tagIds?: string[] }) => {
    state.listProps = props;
    return <div data-testid="list">{(props.tagIds ?? []).join(',')}</div>;
  },
}));

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});
beforeEach(() => {
  state.search = new URLSearchParams();
  state.tags = { data: [{ id: 'tag_a', name: 'alpha', color: '#f00' }], isSuccess: true };
  state.replace.mockClear();
  state.listProps = undefined;
});
afterEach(cleanup);

// The tag list can legitimately be behind the URL (a tag another device just made, a link opened
// before the first pull). Widening the filter in that window would answer a link to ONE tag's notes
// with EVERY note, so the ids are applied as they arrive and the pill explains any it can't resolve.
it('applies a link\u2019s tag id even when it resolves to no known tag', async () => {
  state.search = new URLSearchParams('tags=tag_unpulled');
  render(<NotesScreen />);
  expect(state.listProps?.tagIds).toEqual(['tag_unpulled']);
  await waitFor(() => expect(state.replace).not.toHaveBeenCalled());
});

it('never rewrites the tags in the URL on its own', async () => {
  state.search = new URLSearchParams('tags=tag_a&tags=tag_gone&sort=title');
  render(<NotesScreen />);
  expect(state.listProps?.tagIds).toEqual(['tag_a', 'tag_gone']);
  expect(screen.getByTestId('filter').textContent).toBe('tag_a,tag_gone');
  await waitFor(() => expect(state.replace).not.toHaveBeenCalled());
});

it('applies no tag filter when the link carries none', () => {
  render(<NotesScreen />);
  expect(state.listProps?.tagIds).toBeUndefined();
});
