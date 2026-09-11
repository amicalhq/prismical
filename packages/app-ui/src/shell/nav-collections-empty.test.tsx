// @vitest-environment jsdom
import * as React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarProvider } from '../ui/sidebar';
import { NavNotesGroups } from './nav-notes-groups';

// Sharing the sidebar's Folders and Tags groups: with the group "+" gone, the empty state IS the
// only way to make the first folder or tag from the sidebar, so it has to be a live control and not
// a label. Folders used to render nothing at all when the list was empty.

type Callbacks = { onSuccess?: (created: unknown) => void };

const state = vi.hoisted(() => ({
  folders: [] as { id: string; name: string; favorite?: boolean; createdAt: string }[],
  notes: [] as { id: string; title: string; folderId: string | null; starred?: boolean }[],
  tags: [] as { id: string; name: string; color: string; favorite?: boolean; createdAt: string }[],
  loading: false,
  foldersError: undefined as Error | undefined,
  tagsError: undefined as Error | undefined,
  createdFolder: [] as unknown[],
  createdTag: [] as unknown[],
}));

vi.mock('@prismical/app-client', () => ({
  usePathname: () => '/notes',
  useSearchParams: () => new URLSearchParams(),
  useNavigation: () => ({ push: vi.fn(), replace: vi.fn() }),
  useFeatureFlag: () => ({ enabled: false }),
  // A failed pull surfaces as isLoading false with data undefined (see listResult) — the shape the
  // groups have to tell apart from a genuinely empty workspace.
  useFolders: () => ({
    data: state.foldersError ? undefined : state.folders,
    isLoading: state.loading,
    error: state.foldersError,
  }),
  useNotes: () => ({ data: state.notes, isLoading: state.loading }),
  useTags: () => ({
    data: state.tagsError ? undefined : state.tags,
    isLoading: state.loading,
    error: state.tagsError,
  }),
  useAllNoteTags: () => ({ data: [], isLoading: state.loading }),
  // The callbacks argument is forwarded on purpose: onSuccess is what closes each dialog, and a
  // mock that swallowed it would pass against a dialog that stays open over the sidebar forever.
  useCreateFolder: () => ({
    mutate: (name: unknown, callbacks?: Callbacks) => {
      state.createdFolder.push(name);
      callbacks?.onSuccess?.({ id: 'fld_new', name });
    },
    isPending: false,
  }),
  useUpdateFolder: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteFolder: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateTag: () => ({
    mutate: (input: unknown, callbacks?: Callbacks) => {
      state.createdTag.push(input);
      callbacks?.onSuccess?.({ id: 'tag_new', ...(input as object) });
    },
    isPending: false,
  }),
  useUpdateTag: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteTag: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateNote: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateNote: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteNote: () => ({ mutate: vi.fn(), isPending: false }),
  nextAutoColor: () => '#2563eb',
  TAG_PRESETS: ['#2563eb'],
  normalizeHexColor: (value: string) => value,
  swatchInk: () => '#fff',
}));
vi.mock('../hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${Object.values(vars).join(',')}` : key,
  }),
}));
vi.mock('./app-link', () => ({
  AppLink: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('./share-dialog', () => ({ ShareDialog: () => null }));
vi.mock('./delete-folder-dialog', () => ({ DeleteFolderDialog: () => null }));
vi.mock('./delete-note-dialog', () => ({ DeleteNoteDialog: () => null }));

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});
beforeEach(() => {
  state.folders = [];
  state.notes = [];
  state.tags = [];
  state.loading = false;
  state.foldersError = undefined;
  state.tagsError = undefined;
  state.createdFolder = [];
  state.createdTag = [];
});
afterEach(cleanup);

function renderGroups() {
  return render(
    <SidebarProvider enableKeyboardShortcut={false}>
      <NavNotesGroups />
    </SidebarProvider>
  );
}

describe('sidebar collections empty states', () => {
  it('offers creating the first folder and the first tag', () => {
    renderGroups();
    expect(screen.getByText('navigation.collections.createFolder')).toBeTruthy();
    expect(screen.getByText('navigation.collections.createTag')).toBeTruthy();
  });

  it('creates a folder from the folders empty state', () => {
    renderGroups();
    fireEvent.click(screen.getByText('navigation.collections.createFolder'));
    fireEvent.change(screen.getByLabelText('common.fields.name'), {
      target: { value: '  Meetings  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'dialogs.folder.createAction' }));
    expect(state.createdFolder).toEqual(['Meetings']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('creates a tag from the tags empty state', () => {
    renderGroups();
    fireEvent.click(screen.getByText('navigation.collections.createTag'));
    fireEvent.change(screen.getByLabelText('common.fields.name'), {
      target: { value: 'retro' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'dialogs.tag.create' }));
    expect(state.createdTag).toEqual([{ name: 'retro', color: '#2563eb' }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows skeletons rather than either create row on first load', () => {
    state.loading = true;
    renderGroups();
    expect(screen.queryByText('navigation.collections.createFolder')).toBeNull();
    expect(screen.queryByText('navigation.collections.createTag')).toBeNull();
  });

  it('drops both create rows once a folder and a tag exist', () => {
    state.folders = [{ id: 'fld_1', name: 'Meetings', createdAt: '2026-01-01T00:00:00.000Z' }];
    state.tags = [
      { id: 'tag_1', name: 'retro', color: '#2563eb', createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    renderGroups();
    expect(screen.queryByText('navigation.collections.createFolder')).toBeNull();
    expect(screen.queryByText('navigation.collections.createTag')).toBeNull();
    expect(screen.getByText('Meetings')).toBeTruthy();
  });

  // Each group reads its own collection: a cross-wired condition would light both rows or neither.
  it('offers only the row whose collection is empty', () => {
    state.folders = [{ id: 'fld_1', name: 'Meetings', createdAt: '2026-01-01T00:00:00.000Z' }];
    renderGroups();
    expect(screen.queryByText('navigation.collections.createFolder')).toBeNull();
    expect(screen.getByText('navigation.collections.createTag')).toBeTruthy();
  });

  it('brings each row back when the last folder and tag are deleted', () => {
    state.folders = [{ id: 'fld_1', name: 'Meetings', createdAt: '2026-01-01T00:00:00.000Z' }];
    state.tags = [
      { id: 'tag_1', name: 'retro', color: '#2563eb', createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    const view = renderGroups();
    state.folders = [];
    state.tags = [];
    view.rerender(
      <SidebarProvider enableKeyboardShortcut={false}>
        <NavNotesGroups />
      </SidebarProvider>
    );
    expect(screen.getByText('navigation.collections.createFolder')).toBeTruthy();
    expect(screen.getByText('navigation.collections.createTag')).toBeTruthy();
  });

  // The one that matters most: a pull that FAILED reports isLoading false with no data, so an
  // ungated row would tell someone with a full workspace it is empty — and creating from there
  // mints a name the server already has.
  it('stays silent when the pull failed rather than offering to create', () => {
    state.foldersError = new Error('offline');
    state.tagsError = new Error('offline');
    renderGroups();
    expect(screen.queryByText('navigation.collections.createFolder')).toBeNull();
    expect(screen.queryByText('navigation.collections.createTag')).toBeNull();
  });
});
