// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TagsStrip } from './tags-strip';

const state = vi.hoisted(() => ({
  tags: [] as { id: string; name: string; color: string | null }[],
  notes: [] as { id: string; folderId?: string; tagIds: string[] }[],
  fit: null as number | null,
}));

vi.mock('@prismical/app-client', () => ({
  useTags: () => ({ data: state.tags }),
  useNotes: () => ({ data: state.notes }),
  // The join the list hydrates from, derived here from the fixture notes.
  useAllNoteTags: () => ({
    data: state.notes.flatMap(note => note.tagIds.map(tagId => ({ noteId: note.id, tagId }))),
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count !== undefined ? `${key}:${options.count}` : key,
  }),
}));
// jsdom has no layout, so every pill measures 0 and everything fits. Tests that need overflow pin
// the count directly.
vi.mock('../hooks/use-fit-count', () => ({
  useFitCount: (count: number) => ({
    containerRef: { current: null },
    counterRef: { current: null },
    trailingRef: { current: null },
    itemRef: () => () => {},
    fit: state.fit ?? count,
  }),
}));

beforeEach(() => {
  state.tags = [
    { id: 'tag_sales', name: 'sales', color: '#f00' },
    { id: 'tag_demo', name: 'demo', color: '#0f0' },
    { id: 'tag_1on1', name: '1:1', color: null },
    { id: 'tag_idle', name: 'idle', color: '#00f' },
  ];
  state.notes = [
    { id: 'n1', folderId: 'fld_sales', tagIds: ['tag_sales', 'tag_demo'] },
    { id: 'n2', folderId: 'fld_sales', tagIds: ['tag_sales'] },
    { id: 'n3', folderId: 'fld_personal', tagIds: ['tag_1on1', 'tag_demo'] },
    { id: 'n4', tagIds: ['tag_1on1'] },
  ];
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

function pillNames(): string[] {
  return screen
    .getAllByRole('button', { pressed: false })
    .map(el => el.getAttribute('title') ?? '');
}

it('shows the tags on the notes in view, most used first, and never a tag no note carries', () => {
  render(<TagsStrip selected={[]} onChange={vi.fn()} />);
  expect(pillNames()).toEqual(['1:1', 'demo', 'sales']);
  expect(screen.queryByTitle('idle')).toBeNull();
});

it('scopes the pills to the folders in view', () => {
  render(<TagsStrip selected={[]} onChange={vi.fn()} folderIds={['fld_sales']} />);
  expect(pillNames()).toEqual(['sales', 'demo']);
});

it('puts the selected tags first, pressed, and toggles on click', () => {
  const onChange = vi.fn();
  render(<TagsStrip selected={['tag_demo']} onChange={onChange} />);
  const buttons = screen.getAllByRole('button');
  expect(buttons[0]!.getAttribute('title')).toBe('demo');
  expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByTitle('sales'));
  expect(onChange).toHaveBeenCalledWith(['tag_demo', 'tag_sales']);
  fireEvent.click(screen.getByTitle('demo'));
  expect(onChange).toHaveBeenLastCalledWith(['tag_sales']);
});

it('keeps a selected id the tag list cannot resolve, so the filter stays clearable', () => {
  const onChange = vi.fn();
  render(<TagsStrip selected={['tag_gone']} onChange={onChange} />);
  expect(screen.getByRole('button', { pressed: true }).getAttribute('title')).toBe(
    'notes.tags.unknown'
  );
  fireEvent.click(screen.getByText('notes.tags.clear'));
  expect(onChange).toHaveBeenCalledWith([]);
});

it('folds the pills that do not fit into a searchable list that toggles them', () => {
  const onChange = vi.fn();
  state.fit = 1;
  render(<TagsStrip selected={[]} onChange={onChange} />);
  expect(pillNames()).toEqual(['1:1']);
  fireEvent.click(screen.getByRole('button', { name: 'notes.tags.more:2' }));
  const options = screen.getAllByRole('option');
  expect(options.map(option => option.textContent)).toEqual([
    '#demonotes.tags.noteCount:2',
    '#salesnotes.tags.noteCount:2',
  ]);
  fireEvent.click(options[1]!);
  expect(onChange).toHaveBeenCalledWith(['tag_sales']);
});

it('draws nothing when no note in view carries a tag and none is selected', () => {
  state.notes = [{ id: 'n9', tagIds: [] }];
  const { container } = render(<TagsStrip selected={[]} onChange={vi.fn()} />);
  expect(container.innerHTML).toBe('');
});

// A pill that jumped to the front on every click would make a multi-select a chase, so the order
// only changes with the view, not with the toggles made in it.
it('keeps the order steady while toggling, and leads with the selection on a new view', () => {
  const onChange = vi.fn();
  const view = render(<TagsStrip selected={[]} onChange={onChange} />);
  fireEvent.click(screen.getByTitle('sales'));
  view.rerender(<TagsStrip selected={['tag_sales']} onChange={onChange} />);
  const titles = () =>
    screen
      .getAllByRole('button')
      .map(el => el.getAttribute('title'))
      .filter(Boolean);
  expect(titles()).toEqual(['1:1', 'demo', 'sales']);
  expect(screen.getByTitle('sales').getAttribute('aria-pressed')).toBe('true');
  // Into a folder with that filter still on: the selected tag leads the new row.
  view.rerender(
    <TagsStrip selected={['tag_sales']} onChange={onChange} folderIds={['fld_sales']} />
  );
  expect(titles()).toEqual(['sales', 'demo']);
});
