// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { FoldersScreen } from './folders-screen';

const state = vi.hoisted(() => ({
  folders: {
    data: [] as { id: string; name: string; parentId: string | null; favorite?: boolean }[],
    isLoading: false,
    error: undefined as Error | undefined,
  },
  notes: { data: [] as { id: string; folderId: string | null }[] | undefined, isLoading: false, error: undefined as Error | undefined },
}));

vi.mock('@prismical/app-client', () => ({
  useFolders: () => state.folders,
  useNotes: () => state.notes,
  useCreateFolder: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateFolder: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteFolder: () => ({ mutate: vi.fn(), isPending: false }),
  useFeatureFlag: () => ({ enabled: false }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${Object.values(vars).join(',')}` : key,
  }),
}));
vi.mock('../shell/app-link', () => ({
  AppLink: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../shell/share-dialog', () => ({ ShareDialog: () => null }));
vi.mock('../shell/folder-name-dialog', () => ({ FolderNameDialog: () => null }));
vi.mock('../shell/delete-folder-dialog', () => ({ DeleteFolderDialog: () => null }));

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});
beforeEach(() => {
  state.folders = {
    data: [
      { id: 'fld_meet', name: 'Meetings', parentId: null },
      { id: 'fld_weekly', name: 'Weekly sync', parentId: 'fld_meet' },
      { id: 'fld_1on1', name: '1:1s', parentId: 'fld_meet' },
      { id: 'fld_journal', name: 'Journal', parentId: null },
    ],
    isLoading: false,
    error: undefined,
  };
  state.notes = {
    data: [
      { id: 'n1', folderId: 'fld_meet' },
      { id: 'n2', folderId: 'fld_weekly' },
      { id: 'n3', folderId: 'fld_weekly' },
      { id: 'n4', folderId: 'fld_1on1' },
      { id: 'n5', folderId: null },
    ],
    isLoading: false,
    error: undefined,
  };
});
afterEach(cleanup);

/** Row names in render order, top-level first. */
function rowNames(): string[] {
  return screen.getAllByRole('link').map(link => link.textContent ?? '');
}

function row(name: string): HTMLElement {
  const link = screen.getAllByRole('link').find(el => el.textContent === name);
  if (!link?.parentElement) throw new Error(`no row for ${name}`);
  return link.parentElement;
}

it('shows only root folders until one is expanded', () => {
  render(<FoldersScreen />);
  expect(rowNames()).toEqual(['Journal', 'Meetings']);
});

it('expands a folder from its chevron, revealing children name-sorted', () => {
  render(<FoldersScreen />);
  fireEvent.click(screen.getByLabelText('folders.expand:Meetings'));
  expect(rowNames()).toEqual(['Journal', 'Meetings', '1:1s', 'Weekly sync']);
  fireEvent.click(screen.getByLabelText('folders.collapse:Meetings'));
  expect(rowNames()).toEqual(['Journal', 'Meetings']);
});

// The count is what the row's link actually filters to, and that filter covers the subtree.
it('counts notes across the whole subtree, not just the folder itself', () => {
  render(<FoldersScreen />);
  expect(within(row('Meetings')).getByText('folders.noteCount:4')).toBeTruthy();
  expect(within(row('Journal')).getByText('folders.noteCount:0')).toBeTruthy();
});

it('links a row to its filtered notes list', () => {
  render(<FoldersScreen />);
  expect(screen.getAllByRole('link').find(l => l.textContent === 'Meetings')?.getAttribute('href')).toBe(
    '/notes?folder=fld_meet'
  );
});

it('offers no chevron for a folder with no children', () => {
  render(<FoldersScreen />);
  expect(screen.queryByLabelText('folders.expand:Journal')).toBeNull();
});

// A deep hit behind collapsed parents would be invisible without the forced path.
it('reveals a search match through its collapsed ancestors', () => {
  render(<FoldersScreen />);
  fireEvent.change(screen.getByPlaceholderText('folders.search'), { target: { value: 'weekly' } });
  expect(rowNames()).toEqual(['Meetings', 'Weekly sync']);
});

it('reports a search with no hits', () => {
  render(<FoldersScreen />);
  fireEvent.change(screen.getByPlaceholderText('folders.search'), { target: { value: 'zzz' } });
  expect(screen.getByText('folders.noMatch')).toBeTruthy();
});

// Every folder must appear exactly once — these two shapes are the ones a plain
// `parentId === null` walk drops on the floor.
it('adopts an orphan whose parent it cannot see', () => {
  state.folders.data = [
    { id: 'fld_a', name: 'Visible', parentId: null },
    { id: 'fld_orphan', name: 'Orphan', parentId: 'fld_deleted' },
  ];
  render(<FoldersScreen />);
  // Adopted into the root level, and name-sorted among the real roots.
  expect(rowNames()).toEqual(['Orphan', 'Visible']);
});

it('still renders folders caught in a parent cycle', () => {
  state.folders.data = [
    { id: 'fld_a', name: 'Cycle A', parentId: 'fld_b' },
    { id: 'fld_b', name: 'Cycle B', parentId: 'fld_a' },
  ];
  render(<FoldersScreen />);
  expect(rowNames()).toEqual(['Cycle A']);
  fireEvent.click(screen.getByLabelText('folders.expand:Cycle A'));
  expect(rowNames()).toEqual(['Cycle A', 'Cycle B']);
  // Cycle B's child is Cycle A again; it must not recurse back into the tree.
  expect(screen.queryByLabelText('folders.expand:Cycle B')).toBeNull();
});

// Indentation is capped so a deep tree keeps room for the name and count.
it('stops indenting past the cap', () => {
  state.folders.data = Array.from({ length: 9 }, (_, level) => ({
    id: `fld_${level}`,
    name: `Level ${level}`,
    parentId: level === 0 ? null : `fld_${level - 1}`,
  }));
  render(<FoldersScreen />);
  for (let level = 0; level < 8; level += 1) {
    fireEvent.click(screen.getByLabelText(`folders.expand:Level ${level}`));
  }
  const indentOf = (name: string) => row(name).style.paddingInlineStart;
  expect(indentOf('Level 6')).toBe(indentOf('Level 8'));
  expect(indentOf('Level 5')).not.toBe(indentOf('Level 6'));
});

it('shows the empty state when there are no folders', () => {
  state.folders.data = [];
  render(<FoldersScreen />);
  expect(screen.getByText('folders.empty')).toBeTruthy();
});

it('surfaces a load failure', () => {
  state.folders = { data: [], isLoading: false, error: new Error('offline') };
  render(<FoldersScreen />);
  expect(screen.getByText('common.errors.couldNotLoad')).toBeTruthy();
});

// Search opens the path to a match by seeding the expanded set, so the chevron on a forced-open
// ancestor still works — driving visibility straight off the match set left it inert.
it('collapses a folder the search opened', () => {
  render(<FoldersScreen />);
  fireEvent.change(screen.getByPlaceholderText('folders.search'), { target: { value: 'weekly' } });
  expect(rowNames()).toEqual(['Meetings', 'Weekly sync']);
  fireEvent.click(screen.getByLabelText('folders.collapse:Meetings'));
  expect(rowNames()).toEqual(['Meetings']);
});

// Counts come from the notes collection, which settles separately from folders.
it('waits for notes rather than painting every folder as empty', () => {
  state.notes = { data: [], isLoading: true, error: undefined };
  render(<FoldersScreen />);
  expect(screen.queryByText('folders.noteCount:0')).toBeNull();
});


it('reports a notes load failure instead of false zero counts', () => {
  state.notes = { data: undefined, isLoading: false, error: new Error('offline') };
  render(<FoldersScreen />);
  expect(screen.getByText('common.errors.couldNotLoad')).toBeTruthy();
  expect(screen.queryByText('folders.noteCount:0')).toBeNull();
});

it('reveals a search entered before folders arrive and preserves a later collapse', () => {
  const loadedFolders = state.folders.data;
  state.folders = { data: [], isLoading: true, error: undefined };
  const view = render(<FoldersScreen />);
  fireEvent.change(screen.getByPlaceholderText('folders.search'), { target: { value: 'weekly' } });
  state.folders = { data: loadedFolders, isLoading: false, error: undefined };
  view.rerender(<FoldersScreen />);
  expect(rowNames()).toEqual(['Meetings', 'Weekly sync']);

  fireEvent.click(screen.getByLabelText('folders.collapse:Meetings'));
  state.notes.data = [...(state.notes.data ?? []), { id: 'n6', folderId: 'fld_weekly' }];
  state.folders.data = [...loadedFolders];
  view.rerender(<FoldersScreen />);
  expect(rowNames()).toEqual(['Meetings']);
});


it('waits for the collection before allowing folder creation', () => {
  state.folders.isLoading = true;
  render(<FoldersScreen />);
  expect((screen.getByRole('button', { name: 'folders.new' }) as HTMLButtonElement).disabled).toBe(true);
});
