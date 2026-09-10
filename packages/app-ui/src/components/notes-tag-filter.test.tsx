// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { NotesTagFilter } from './notes-tag-filter';

vi.mock('@prismical/app-client', () => ({
  useTags: () => ({
    data: [
      { id: 'tag_b', name: 'beta', color: '#00ff00', favorite: false },
      { id: 'tag_a', name: 'alpha', color: '#ff0000', favorite: false },
    ],
  }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

beforeAll(() => {
  // cmdk measures its list; jsdom has neither API.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

async function openFilter() {
  fireEvent.click(screen.getByLabelText('notes.tags.filter'));
  await screen.findAllByRole('option');
}

/** The dropdown row for a tag (the trigger renders the same names as chips). */
function option(name: string): HTMLElement {
  const found = screen
    .getAllByRole('option')
    .find(el => within(el).queryByText(name) !== null);
  if (!found) throw new Error(`no option for ${name}`);
  return found;
}

function optionNames(): string[] {
  return screen.getAllByRole('option').map(el => el.textContent?.replace('#', '') ?? '');
}

// The host commits the URL asynchronously, so `selected` still holds the pre-click value when the
// next pick arrives. Computing that pick off the prop dropped the first tag.
it('adds to the picks already made while the URL commit is still in flight', async () => {
  const onChange = vi.fn();
  render(<NotesTagFilter selected={[]} onChange={onChange} />);
  await openFilter();
  fireEvent.click(option('alpha'));
  fireEvent.click(option('beta'));
  expect(onChange.mock.calls.map(call => call[0])).toEqual([['tag_a'], ['tag_a', 'tag_b']]);
});

it('removes from the uncommitted picks too', async () => {
  const onChange = vi.fn();
  render(<NotesTagFilter selected={[]} onChange={onChange} />);
  await openFilter();
  fireEvent.click(option('alpha'));
  fireEvent.click(option('beta'));
  fireEvent.click(option('alpha'));
  expect(onChange.mock.calls.at(-1)?.[0]).toEqual(['tag_b']);
});

it('clears every selected tag at once', async () => {
  const onChange = vi.fn();
  render(<NotesTagFilter selected={['tag_a', 'tag_b']} onChange={onChange} />);
  await openFilter();
  fireEvent.click(option('notes.tags.clear'));
  expect(onChange).toHaveBeenCalledWith([]);
});

it('offers no clear row when nothing is selected', async () => {
  render(<NotesTagFilter selected={[]} onChange={vi.fn()} />);
  await openFilter();
  expect(screen.queryByText('notes.tags.clear')).toBeNull();
});

it('lists tags by name, not in sync order', async () => {
  render(<NotesTagFilter selected={[]} onChange={vi.fn()} />);
  await openFilter();
  expect(optionNames()).toEqual(['alpha', 'beta']);
});

// An id the tag list can't resolve (yet, or ever) must stay visible and clearable: it is what makes
// the notes list look empty, and dropping it would answer a one-tag link with every note.
it('shows an unresolved selected id as a chip instead of an empty pill', async () => {
  render(<NotesTagFilter selected={['tag_gone']} onChange={vi.fn()} />);
  expect(screen.getByLabelText('notes.tags.filter').textContent).toContain('notes.tags.unknown');
});

it('offers the clear row when only unresolved ids are selected', async () => {
  const onChange = vi.fn();
  render(<NotesTagFilter selected={['tag_gone']} onChange={onChange} />);
  await openFilter();
  fireEvent.click(option('notes.tags.clear'));
  expect(onChange).toHaveBeenCalledWith([]);
});

it('keeps unresolved ids when another tag is picked', async () => {
  const onChange = vi.fn();
  render(<NotesTagFilter selected={['tag_gone']} onChange={onChange} />);
  await openFilter();
  fireEvent.click(option('alpha'));
  expect(onChange).toHaveBeenCalledWith(['tag_gone', 'tag_a']);
});

it('keeps newer picks when the URL acknowledges an earlier selection', async () => {
  const onChange = vi.fn();
  const view = render(<NotesTagFilter selected={[]} onChange={onChange} />);
  await openFilter();
  fireEvent.click(option('alpha'));
  fireEvent.click(option('beta'));
  view.rerender(<NotesTagFilter selected={['tag_a']} onChange={onChange} />);
  fireEvent.click(option('alpha'));
  expect(onChange.mock.calls.at(-1)?.[0]).toEqual(['tag_b']);
});

it('accepts external navigation while picks are awaiting a URL commit', async () => {
  const onChange = vi.fn();
  const view = render(<NotesTagFilter selected={[]} onChange={onChange} />);
  await openFilter();
  fireEvent.click(option('alpha'));
  view.rerender(<NotesTagFilter selected={['tag_gone']} onChange={onChange} />);
  fireEvent.click(option('beta'));
  expect(onChange.mock.calls.at(-1)?.[0]).toEqual(['tag_gone', 'tag_b']);
});
