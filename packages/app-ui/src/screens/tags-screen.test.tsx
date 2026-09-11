// @vitest-environment jsdom
import type { ReactElement, ReactNode } from 'react';
import { Children, cloneElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { TagsScreen } from './tags-screen';

const state = vi.hoisted(() => ({
  tags: {
    data: [] as
      | { id: string; name: string; color: string; createdAt: string; favorite?: boolean }[]
      | undefined,
    isLoading: false,
    error: undefined as Error | undefined,
  },
  noteTags: {
    data: [] as { noteId: string; tagId: string }[] | undefined,
    isLoading: false,
    error: undefined as Error | undefined,
  },
  created: [] as unknown[],
  createPending: false,
}));

vi.mock('@prismical/app-client', () => ({
  useTags: () => state.tags,
  useAllNoteTags: () => state.noteTags,
  useCreateTag: () => ({ mutate: (input: unknown) => state.created.push(input), isPending: state.createPending }),
  useUpdateTag: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteTag: () => ({ mutate: vi.fn(), isPending: false }),
  nextAutoColor: () => '#f59e0b',
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
// Flattened so the menu's contents are in the tree without driving Radix's pointer machinery,
// which needs layout jsdom does not have.
vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => children,
  DropdownMenuSeparator: () => null,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" role="menuitem" onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  DropdownMenuRadioGroup: ({
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) =>
    Children.map(children, child =>
      cloneElement(child as ReactElement<{ onValueChange?: (value: string) => void }>, {
        onValueChange,
      })
    ),
  DropdownMenuRadioItem: ({
    value,
    children,
    onValueChange,
  }: {
    value: string;
    children: ReactNode;
    onValueChange?: (value: string) => void;
  }) => (
    <button type="button" role="menuitemradio" onClick={() => onValueChange?.(value)}>
      {children}
    </button>
  ),
}));
vi.mock('../shell/tag-edit-dialog', () => ({
  TagEditDialog: (props: {
    open: boolean;
    mode?: string;
    tag?: { id: string } | null;
    takenNames?: readonly string[];
    pending?: boolean;
    onSubmit: (values: { name: string; color: string }) => void;
  }) => (
    <div
      data-testid={props.mode === 'create' ? 'create-dialog' : 'edit-dialog'}
      data-open={String(props.open)}
      data-pending={String(props.pending ?? false)}
      data-tag={props.tag?.id ?? ''}
      data-taken={(props.takenNames ?? []).join(',')}
    >
      {props.open && props.mode === 'create' ? (
        <button onClick={() => props.onSubmit({ name: 'fresh', color: '#f59e0b' })}>Submit create</button>
      ) : null}
    </div>
  ),
}));
vi.mock('../shell/delete-tag-dialog', () => ({ DeleteTagDialog: () => null }));

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});
beforeEach(() => {
  state.tags = {
    data: [
      { id: 'tag_road', name: 'roadmap', color: '#7f77dd', createdAt: '2026-01-01' },
      { id: 'tag_call', name: 'calls', color: '#378add', createdAt: '2026-01-02', favorite: true },
      { id: 'tag_arch', name: 'archive', color: '#d85a30', createdAt: '2026-01-03' },
    ],
    isLoading: false,
    error: undefined,
  };
  state.noteTags = {
    data: [
      { noteId: 'n1', tagId: 'tag_call' },
      { noteId: 'n2', tagId: 'tag_call' },
      { noteId: 'n3', tagId: 'tag_road' },
    ],
    isLoading: false,
    error: undefined,
  };
  state.created = [];
  state.createPending = false;
});
afterEach(cleanup);

/** Tag names in render order. */
function rowNames(): string[] {
  return screen.queryAllByRole('link').map(link => link.textContent?.replace('#', '') ?? '');
}

it('lists every tag name-sorted, whatever order the store hands back', () => {
  render(<TagsScreen />);
  expect(rowNames()).toEqual(['archive', 'calls', 'roadmap']);
});

// The sidebar shows only the newest five, so an older tag is reachable nowhere else.
it('links each tag to its filtered note list', () => {
  render(<TagsScreen />);
  const link = screen.getAllByRole('link').find(el => el.textContent === '#roadmap');
  expect(link?.getAttribute('href')).toBe('/notes?tags=tag_road');
});

it('counts the notes carrying each tag', () => {
  render(<TagsScreen />);
  expect(screen.getByText('tags.noteCount:2')).toBeTruthy();
  expect(screen.getByText('tags.noteCount:1')).toBeTruthy();
});

// A tag no note carries is the main thing you come here to delete: it reads as a state, not a zero.
it('says a tag has no notes rather than counting zero', () => {
  render(<TagsScreen />);
  expect(screen.getByText('tags.noNotes')).toBeTruthy();
  expect(screen.queryByText('tags.noteCount:0')).toBeNull();
});

it('orders by note count on request, breaking ties by name', () => {
  render(<TagsScreen />);
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'tags.sortByCount' }));
  expect(rowNames()).toEqual(['calls', 'roadmap', 'archive']);
});

it('narrows to favorites without reordering them', () => {
  render(<TagsScreen />);
  fireEvent.click(screen.getByRole('button', { name: /tags.favoritesOnly/ }));
  expect(rowNames()).toEqual(['calls']);
});

it('searches by name, and composes with the favorites filter', () => {
  render(<TagsScreen />);
  fireEvent.change(screen.getByPlaceholderText('tags.search'), { target: { value: 'a' } });
  expect(rowNames()).toEqual(['archive', 'calls', 'roadmap']);
  fireEvent.click(screen.getByRole('button', { name: /tags.favoritesOnly/ }));
  expect(rowNames()).toEqual(['calls']);
});

// "No tags" and "nothing matched" are different problems; saying the wrong one reads as data loss.
it('tells an empty filter apart from an empty account', () => {
  render(<TagsScreen />);
  fireEvent.change(screen.getByPlaceholderText('tags.search'), { target: { value: 'zzz' } });
  expect(screen.getByText('tags.noMatch')).toBeTruthy();
  cleanup();

  state.tags = { data: [], isLoading: false, error: undefined };
  render(<TagsScreen />);
  expect(screen.getByText('tags.empty')).toBeTruthy();
});

// Counts arrive on their own lane; painting the list first shows every tag as having no notes.
it('waits for the note links before drawing any counts', () => {
  state.noteTags = { data: [], isLoading: true, error: undefined };
  render(<TagsScreen />);
  expect(screen.queryByText('tags.noNotes')).toBeNull();
  expect(rowNames()).toEqual([]);
});

it('shows the error card when the tags never load', () => {
  state.tags = { data: undefined, isLoading: false, error: new Error('offline') };
  render(<TagsScreen />);
  expect(rowNames()).toEqual([]);
  expect(screen.getByText('common.errors.couldNotLoad')).toBeTruthy();
});

// Without the note links every tag reads "No notes", which is this screen's own cue for deleting
// one — so a failed counts lane must not render a list that invites pruning tags that are in use.
it('refuses to draw the list when the counts failed to load', () => {
  state.noteTags = { data: undefined, isLoading: false, error: new Error('offline') };
  render(<TagsScreen />);
  expect(rowNames()).toEqual([]);
  expect(screen.queryByText('tags.noNotes')).toBeNull();
  expect(screen.getByText('common.errors.couldNotLoad')).toBeTruthy();
});

// The guard against a colliding name needs the tags to compare against.
it('cannot start a create before the tags have landed', () => {
  state.tags = { data: undefined, isLoading: true, error: undefined };
  render(<TagsScreen />);
  expect((screen.getByRole('button', { name: /tags.new/ }) as HTMLButtonElement).disabled).toBe(
    true
  );
});

// `renameTag` assigns into `tags$[id]` without checking the row is still there, so saving against a
// tag that has since been deleted elsewhere would write it back as a row with no id and no color.
it('closes the edit dialog when the tag it points at leaves the store', () => {
  const { rerender } = render(<TagsScreen />);
  fireEvent.click(screen.getAllByRole('menuitem', { name: 'dialogs.tag.title' })[0]!);
  const dialog = () => screen.getByTestId('edit-dialog');
  expect(dialog().getAttribute('data-open')).toBe('true');
  expect(dialog().getAttribute('data-tag')).toBe('tag_arch');

  state.tags = { ...state.tags, data: state.tags.data!.filter(tag => tag.id !== 'tag_arch') };
  rerender(<TagsScreen />);
  expect(dialog().getAttribute('data-open')).toBe('false');
});

// The dialog receives the full collection and excludes the edited tag itself.
it('hands the edit dialog every available tag name', () => {
  render(<TagsScreen />);
  fireEvent.click(screen.getAllByRole('menuitem', { name: 'dialogs.tag.title' })[0]!);
  expect(screen.getByTestId('edit-dialog').getAttribute('data-taken')).toBe('roadmap,calls,archive');
});


it('cannot start a create after the tags failed to load', () => {
  state.tags = { data: undefined, isLoading: false, error: new Error('offline') };
  render(<TagsScreen />);
  expect((screen.getByRole('button', { name: /tags.new/ }) as HTMLButtonElement).disabled).toBe(true);
});

it('blocks an open create dialog if the tag collection becomes unavailable', () => {
  const view = render(<TagsScreen />);
  fireEvent.click(screen.getByRole('button', { name: /tags.new/ }));
  state.tags = { data: undefined, isLoading: true, error: undefined };
  view.rerender(<TagsScreen />);
  expect(screen.getByTestId('create-dialog').getAttribute('data-pending')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Submit create' }));
  expect(state.created).toEqual([]);
});

it('blocks create while the mutation is unavailable', () => {
  state.createPending = true;
  render(<TagsScreen />);
  expect((screen.getByRole('button', { name: /tags.new/ }) as HTMLButtonElement).disabled).toBe(true);
});
