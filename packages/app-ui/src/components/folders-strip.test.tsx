// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FoldersStrip } from './folders-strip';

type Folder = { id: string; name: string; parentId: string | null; createdAt: string };

const state = vi.hoisted(() => ({
  folders: [] as Folder[],
  foldersLoading: false,
  notes: [] as { id: string; folderId: string | null }[],
  search: new URLSearchParams(),
  push: vi.fn(),
  create: vi.fn(),
  fit: null as number | null,
}));

vi.mock('@prismical/app-client', () => ({
  useFolders: () => ({ data: state.folders, isLoading: state.foldersLoading }),
  useNotes: () => ({ data: state.notes }),
  useFeatureFlag: () => ({ enabled: false, isResolved: true }),
  useCreateFolder: () => ({ mutate: state.create, isPending: false }),
  useUpdateFolder: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteFolder: () => ({ mutate: vi.fn(), isPending: false }),
  useNavigation: () => ({ push: state.push, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => state.search,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; name?: string }) =>
      options?.count !== undefined
        ? `${key}:${options.count}`
        : options?.name
          ? `${key}:${options.name}`
          : key,
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
// Flattened so each chip's menu rows are in the tree without Radix's pointer machinery.
vi.mock('../ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => children,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => children,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => children,
  ContextMenuSeparator: () => null,
  ContextMenuSub: ({ children }: { children: React.ReactNode }) => children,
  ContextMenuSubTrigger: ({ children }: { children: React.ReactNode }) => children,
  ContextMenuSubContent: ({ children }: { children: React.ReactNode }) => children,
  ContextMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" role="menuitem" onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
}));
vi.mock('../shell/delete-folder-dialog', () => ({ DeleteFolderDialog: () => null }));
vi.mock('../shell/folder-name-dialog', () => ({
  FolderNameDialog: ({
    open,
    parentName,
    onSubmit,
  }: {
    open: boolean;
    parentName?: string;
    onSubmit: (name: string) => void;
  }) =>
    open ? (
      <div data-testid="dialog" data-parent={parentName ?? ''}>
        <button type="button" onClick={() => onSubmit('Fresh')}>
          submit
        </button>
      </div>
    ) : null,
}));
// jsdom has no layout, so every chip measures 0 and everything fits. Tests that need overflow
// pin the count directly.
vi.mock('../hooks/use-fit-count', () => ({
  useFitCount: (count: number) => ({
    containerRef: { current: null },
    counterRef: { current: null },
    trailingRef: { current: null },
    itemRef: () => () => {},
    fit: state.fit ?? count,
  }),
}));

const folder = (id: string, name: string, parentId: string | null = null): Folder => ({
  id,
  name,
  parentId,
  createdAt: '2026-01-01T00:00:00Z',
});

beforeEach(() => {
  state.folders = [
    folder('fld_work', 'Work'),
    folder('fld_personal', 'Personal'),
    folder('fld_clients', 'Clients', 'fld_work'),
    folder('fld_acme', 'Acme', 'fld_clients'),
  ];
  state.foldersLoading = false;
  state.notes = [
    { id: 'n1', folderId: 'fld_acme' },
    { id: 'n2', folderId: 'fld_clients' },
    { id: 'n3', folderId: 'fld_personal' },
  ];
  state.search = new URLSearchParams();
  state.push.mockClear();
  state.create.mockClear();
  state.fit = null;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('lists the top-level folders at the root with subtree counts, alphabetical', () => {
  render(<FoldersStrip parentId={null} />);
  const links = screen.getAllByRole('link');
  expect(links.map(link => link.textContent)).toEqual(['Personal1', 'Work2']);
  expect(links[1]!.getAttribute('href')).toBe('/notes?folder=fld_work');
});

it('lists a folder’s own children inside it and keeps the other filters on the links', () => {
  state.search = new URLSearchParams('folder=fld_work&tags=tag_a');
  render(<FoldersStrip parentId="fld_work" />);
  const links = screen.getAllByRole('link');
  expect(links.map(link => link.textContent)).toEqual(['Clients2']);
  expect(links[0]!.getAttribute('href')).toBe('/notes?folder=fld_clients&tags=tag_a');
});

it('offers a new top-level folder at the root, even before any exist', () => {
  state.folders = [];
  state.notes = [];
  render(<FoldersStrip parentId={null} />);
  fireEvent.click(screen.getByRole('button', { name: 'folders.new' }));
  expect(screen.getByTestId('dialog').getAttribute('data-parent')).toBe('');
  fireEvent.click(screen.getByText('submit'));
  expect(state.create).toHaveBeenCalledWith({ name: 'Fresh', parentId: null }, expect.anything());
});

it('draws nothing inside a childless folder at the depth cap', () => {
  const { container } = render(<FoldersStrip parentId="fld_acme" />);
  expect(container.innerHTML).toBe('');
});

it('offers a subfolder without feature flags, naming the parent', () => {
  render(<FoldersStrip parentId="fld_work" />);
  fireEvent.click(screen.getByRole('button', { name: 'folders.newSubfolder' }));
  expect(screen.getByTestId('dialog').getAttribute('data-parent')).toBe('Work');
  fireEvent.click(screen.getByText('submit'));
  expect(state.create).toHaveBeenCalledWith(
    { name: 'Fresh', parentId: 'fld_work' },
    expect.anything()
  );
});

it('offers creation at the second level without feature flags', () => {
  render(<FoldersStrip parentId="fld_clients" />);
  fireEvent.click(screen.getByRole('button', { name: 'folders.newSubfolder' }));
  fireEvent.click(screen.getByText('submit'));
  expect(state.create).toHaveBeenCalledWith(
    { name: 'Fresh', parentId: 'fld_clients' }, expect.anything()
  );
});

it('stops offering subfolders at the depth cap', () => {
  render(<FoldersStrip parentId="fld_acme" />);
  expect(screen.queryByRole('button', { name: 'folders.newSubfolder' })).toBeNull();
});

it('folds the folders that do not fit into a searchable counter', () => {
  state.folders = [
    folder('fld_a', 'Alpha'),
    folder('fld_b', 'Beta'),
    folder('fld_c', 'Gamma'),
    folder('fld_d', 'Delta'),
  ];
  state.notes = [];
  state.fit = 2;
  render(<FoldersStrip parentId={null} />);
  // Delta sorts before Gamma, so the two shown are Alpha and Beta.
  expect(screen.getAllByRole('link').map(link => link.textContent)).toEqual(['Alpha0', 'Beta0']);
  fireEvent.click(screen.getByRole('button', { name: 'folders.more:2' }));
  const options = screen.getAllByRole('option');
  expect(options.map(option => option.textContent)).toEqual([
    'Deltafolders.noteCount:0',
    'Gammafolders.noteCount:0',
  ]);
  fireEvent.click(options[1]!);
  expect(state.push).toHaveBeenCalledWith('/notes?folder=fld_c');
});

it('draws nothing while folders are still loading', () => {
  state.foldersLoading = true;
  const { container } = render(<FoldersStrip parentId={null} />);
  expect(container.innerHTML).toBe('');
});

it('gives every chip the folder menu, with rename and delete', () => {
  render(<FoldersStrip parentId={null} />);
  expect(screen.getAllByRole('menuitem', { name: 'common.actions.rename' })).toHaveLength(2);
  expect(screen.getAllByRole('menuitem', { name: 'common.actions.delete' })).toHaveLength(2);
});
