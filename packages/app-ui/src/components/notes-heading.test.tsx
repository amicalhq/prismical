// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NotesHeading } from './notes-heading';

const state = vi.hoisted(() => ({
  folders: [] as { id: string; name: string; parentId: string | null; createdAt: string }[],
  search: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
  remove: vi.fn(),
  sharing: false,
  members: undefined as
    | {
        canManage: boolean;
        members: { orgUserId: string; name: string; email: string; image: string | null }[];
        inherited: never[];
      }
    | undefined,
}));

vi.mock('@prismical/app-client', () => ({
  useFolders: () => ({ data: state.folders }),
  useSearchParams: () => state.search,
  useNavigation: () => ({ push: state.push, replace: state.replace, back: vi.fn() }),
  useFeatureFlag: (key: string) => ({
    enabled: key === 'sharing' ? state.sharing : false,
  }),
  useFolderMembers: () => ({ data: state.members }),
  useCreateFolder: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateFolder: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteFolder: () => ({ mutate: state.remove, isPending: false }),
}));
vi.mock('../shell/share-dialog', () => ({ ShareDialog: () => null }));
vi.mock('../shell/folder-name-dialog', () => ({ FolderNameDialog: () => null }));
// The confirmation is the parent's: it renders its buttons, so the delete can be driven here.
vi.mock('../shell/delete-folder-dialog', () => ({
  DeleteFolderDialog: ({
    folder,
    onConfirm,
  }: {
    folder: { id: string; name: string } | null;
    onConfirm: () => void;
  }) =>
    folder ? (
      <button type="button" onClick={onConfirm}>
        confirm-delete
      </button>
    ) : null,
}));
// Flattened so the menu's rows are in the tree without Radix's pointer machinery.
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
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count !== undefined ? `${key}:${options.count}` : key,
  }),
}));
vi.mock('../shell/app-link', () => ({
  AppLink: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const folder = (id: string, name: string, parentId: string | null = null) => ({
  id,
  name,
  parentId,
  createdAt: '2026-01-01T00:00:00Z',
});

beforeEach(() => {
  state.folders = [
    folder('fld_work', 'Work'),
    folder('fld_clients', 'Clients', 'fld_work'),
    folder('fld_acme', 'Acme', 'fld_clients'),
  ];
  state.search = new URLSearchParams();
  state.sharing = false;
  state.members = undefined;
});
afterEach(cleanup);

it('is the plain page title at the root', () => {
  render(<NotesHeading folderId={null} />);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('notes.list.title');
  expect(screen.queryByRole('navigation')).toBeNull();
});

it('is the path down to the folder, with each earlier segment a link one level up', () => {
  state.search = new URLSearchParams('folder=fld_acme&tags=tag_a');
  render(<NotesHeading folderId="fld_acme" />);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Acme');
  const links = screen.getAllByRole('link');
  expect(links.map(link => link.textContent)).toEqual(['notes.list.title', 'Work', 'Clients']);
  // The other filters ride along; only the folder changes.
  expect(links.map(link => link.getAttribute('href'))).toEqual([
    '/notes?tags=tag_a',
    '/notes?folder=fld_work&tags=tag_a',
    '/notes?folder=fld_clients&tags=tag_a',
  ]);
});

it('falls back to the plain title for a folder the list does not know', () => {
  render(<NotesHeading folderId="fld_gone" />);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('notes.list.title');
  expect(screen.queryByRole('link')).toBeNull();
});

it('carries the folder’s menu on the last crumb, and deleting it leaves you one level up', () => {
  state.search = new URLSearchParams('folder=fld_acme&tags=tag_a');
  render(<NotesHeading folderId="fld_acme" />);
  expect(screen.getByRole('button', { name: 'folders.options' })).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitem', { name: 'common.actions.delete' }));
  fireEvent.click(screen.getByText('confirm-delete'));
  // Replaced, not pushed: Back must not land on the folder that no longer exists.
  expect(state.replace).toHaveBeenCalledWith('/notes?folder=fld_clients&tags=tag_a');
  expect(state.remove).toHaveBeenCalledWith('fld_acme', expect.anything());
});

it('offers subfolder creation without feature flags', () => {
  state.search = new URLSearchParams('folder=fld_clients');
  render(<NotesHeading folderId="fld_clients" />);
  expect(screen.getByRole('menuitem', { name: 'folders.newSubfolder' })).toBeTruthy();
});

it('shows who has access, and Share, inside a shared folder', () => {
  state.sharing = true;
  state.members = {
    canManage: true,
    members: [
      { orgUserId: 'ou_1', name: 'Ada Lovelace', email: 'ada@example.com', image: null },
      { orgUserId: 'ou_2', name: 'Bo Diddley', email: 'bo@example.com', image: null },
    ],
    // Ada again, through the parent: counted once.
    inherited: [
      { orgUserId: 'ou_1', name: 'Ada Lovelace', email: 'ada@example.com', image: null },
    ] as never[],
  };
  render(<NotesHeading folderId="fld_work" />);
  expect(screen.getByRole('button', { name: /folders\.sharedWith/ }).textContent).toContain(
    'folders.sharedWith:2'
  );
  expect(screen.getByRole('button', { name: 'navigation.collections.shareFolder' })).toBeTruthy();
});

it('says whose folder it is when it was shared with me, and keeps the owner-only actions off', () => {
  state.folders = [
    { ...folder('fld_theirs', 'Theirs'), isOwner: false, sharedByName: 'Ada' } as never,
  ];
  render(<NotesHeading folderId="fld_theirs" />);
  expect(screen.getByText('folders.sharedBy')).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: 'common.actions.delete' })).toBeNull();
});
