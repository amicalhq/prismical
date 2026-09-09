// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NoteTagEditor } from './note-tag-editor';
const { create, add } = vi.hoisted(() => ({ create: vi.fn(), add: vi.fn() }));
vi.mock('@prismical/app-client', () => ({
  useTags: () => ({ data: [{ id: 'work', name: 'Work', color: '#000' }] }),
  useAddNoteTag: () => ({ mutate: add }),
  useRemoveNoteTag: () => ({ mutate: vi.fn() }),
  useCreateTag: () => ({ mutate: create, isPending: false }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: { name: string }) => (args ? `${key}:${args.name}` : key),
  }),
}));
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  Element.prototype.scrollIntoView = vi.fn();
  create.mockImplementation((_name, callbacks) => callbacks.onSuccess({ id: 'new' }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it('shows and creates a new tag when no existing tag matches', () => {
  render(<NoteTagEditor noteId="note" selected={[]} />);
  fireEvent.click(screen.getByRole('button', { name: 'notes.tags.add' }));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Fresh' } });
  const option = screen.getByRole('option', { name: 'notes.tags.create:Fresh' });
  expect(option.closest('[hidden]')).toBeNull();
  fireEvent.click(option);
  expect(create).toHaveBeenCalledWith('Fresh', expect.any(Object));
  expect(add).toHaveBeenCalledWith('new');
});
