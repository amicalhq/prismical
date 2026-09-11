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
// Flattened so the row menus' contents are in the tree without driving Radix's pointer machinery,
// which needs layout jsdom does not have.
vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuSeparator: () => null,
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuSubTrigger: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      role="menuitem"
      aria-disabled={disabled ? 'true' : undefined}
      onClick={() => !disabled && onSelect?.()}
    >
      {children}
    </button>
  ),
}));
vi.mock('../shell/share-dialog', () => ({ ShareDialog: () => null }));
vi.mock('../shell/folder-name-dialog', () => ({
  FolderNameDialog: (props: { open: boolean; mode: string; parentName?: string }) => (
    <div
      data-testid={`folder-dialog-${props.mode}`}
      data-open={String(props.open)}
      data-parent={props.parentName ?? ''}
    />
  ),
}));
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
      { id: 'fld_meet', name: 'Meetings', parentId: null, favorite: true },
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






// The folder icon doubles as the toggle, so a folder with nothing inside must not be a button —
// hovering it would otherwise promise children it does not have.
it('gives a toggle only to folders that have children', () => {
  render(<FoldersScreen />);
  expect(screen.getByLabelText('folders.expand:Meetings')).toBeTruthy();
  expect(screen.queryByLabelText('folders.expand:Journal')).toBeNull();
  expect(screen.getAllByRole('button', { name: /folders.expand/ })).toHaveLength(1);
});

/** Open a row's menu is a no-op here: the menu is flattened, so its items are already in the tree. */
function menuItem(name: string, nth = 0): HTMLElement {
  return screen.getAllByRole('menuitem', { name })[nth]!;
}

// Three tiers is the limit, so a row at the second-to-last tier can still hold one and the last
// cannot. Disabled rather than absent: a missing item reads as the feature not existing.
it('offers a subfolder until the depth limit, then disables it', () => {
  state.folders = {
    data: [
      { id: 'fld_1', name: 'One', parentId: null },
      { id: 'fld_2', name: 'Two', parentId: 'fld_1' },
      { id: 'fld_3', name: 'Three', parentId: 'fld_2' },
    ],
    isLoading: false,
    error: undefined,
  };
  render(<FoldersScreen />);
  fireEvent.click(screen.getByLabelText('folders.expand:One'));
  fireEvent.click(screen.getByLabelText('folders.expand:Two'));
  expect(rowNames()).toEqual(['One', 'Two', 'Three']);

  const items = screen.getAllByRole('menuitem', { name: 'folders.newSubfolder' });
  expect(items).toHaveLength(3);
  expect(items[0]!.getAttribute('aria-disabled')).not.toBe('true');
  expect(items[1]!.getAttribute('aria-disabled')).not.toBe('true');
  expect(items[2]!.getAttribute('aria-disabled')).toBe('true');
});

it('names the parent the new folder is landing in', () => {
  render(<FoldersScreen />);
  const dialog = () => screen.getByTestId('folder-dialog-create');
  expect(dialog().getAttribute('data-open')).toBe('false');
  fireEvent.click(menuItem('folders.newSubfolder'));
  expect(dialog().getAttribute('data-open')).toBe('true');
  // Rows are name-sorted, so the first is Journal.
  expect(dialog().getAttribute('data-parent')).toBe('Journal');
});

// Creating at the top level after creating inside one must not still name the old parent.
it('forgets the parent when the toolbar starts a new folder', () => {
  render(<FoldersScreen />);
  fireEvent.click(menuItem('folders.newSubfolder'));
  expect(screen.getByTestId('folder-dialog-create').getAttribute('data-parent')).toBe('Journal');
  fireEvent.click(screen.getByRole('button', { name: /folders.new$/ }));
  expect(screen.getByTestId('folder-dialog-create').getAttribute('data-parent')).toBe('');
});

/** The move targets offered for the row whose own name is `name`. */
function moveTargets(name: string): { label: string; disabled: boolean }[] {
  const row = row_(name);
  return [...row.querySelectorAll('[role="menuitem"]')]
    .map(el => ({ label: el.textContent ?? '', disabled: el.getAttribute('aria-disabled') === 'true' }))
    .filter(item => !/newSubfolder|rename|delete|shareFolder|Favorites/i.test(item.label));
}
function row_(name: string): HTMLElement {
  const link = screen.getAllByRole('link').find(el => el.textContent === name);
  if (!link?.parentElement) throw new Error(`no row for ${name}`);
  return link.parentElement;
}

function nested() {
  state.folders = {
    data: [
      { id: 'fld_1', name: 'One', parentId: null },
      { id: 'fld_2', name: 'Two', parentId: 'fld_1' },
      { id: 'fld_3', name: 'Three', parentId: 'fld_2' },
      { id: 'fld_flat', name: 'Flat', parentId: null },
    ],
    isLoading: false,
    error: undefined,
  };
}

// Moving a folder into its own subtree strands the whole branch, so those rows are not offered.
it('never offers a folder its own subtree as a destination', () => {
  nested();
  render(<FoldersScreen />);
  fireEvent.click(screen.getByLabelText('folders.expand:One'));
  fireEvent.click(screen.getByLabelText('folders.expand:Two'));
  const labels = moveTargets('Two').map(item => item.label);
  expect(labels).toContain('Flat');
  expect(labels).not.toContain('Two');
  expect(labels).not.toContain('Three');
});

// A folder carrying children needs room for them: One is three tiers tall, so nowhere can take it.
it('refuses a destination that would push the subtree past the limit', () => {
  nested();
  render(<FoldersScreen />);
  fireEvent.click(screen.getByLabelText('folders.expand:One'));
  fireEvent.click(screen.getByLabelText('folders.expand:Two'));
  expect(moveTargets('One').map(i => i.label)).toContain('folders.noMoveTargets');
  // A leaf carries nothing, so the same destination is fine for the deepest row.
  expect(moveTargets('Three').map(i => i.label)).toContain('Flat');
});

it('greys out the folder it already lives in, and the top level for a root folder', () => {
  nested();
  render(<FoldersScreen />);
  fireEvent.click(screen.getByLabelText('folders.expand:One'));
  fireEvent.click(screen.getByLabelText('folders.expand:Two'));
  expect(moveTargets('Flat').find(i => i.label === 'folders.moveToRoot')?.disabled).toBe(true);
  const forThree = moveTargets('Three');
  expect(forThree.find(i => i.label === 'Two')?.disabled).toBe(true);
  expect(forThree.find(i => i.label === 'folders.moveToRoot')?.disabled).toBe(false);
});

// The star is the only favorite control now that the menu item is gone.
it('toggles a favorite straight from the row', () => {
  render(<FoldersScreen />);
  // Only the two root rows are drawn until something is expanded: Journal, then Meetings.
  const stars = screen.getAllByRole('button', { name: 'navigation.collections.addToFavorites' });
  expect(stars).toHaveLength(1);
  expect(stars[0]!.getAttribute('aria-pressed')).toBe('false');
  // Meetings is the fixture's favorite, so its star reads pressed and offers the opposite action.
  const pressed = screen.getAllByRole('button', {
    name: 'navigation.collections.removeFromFavorites',
  });
  expect(pressed[0]!.getAttribute('aria-pressed')).toBe('true');
});
