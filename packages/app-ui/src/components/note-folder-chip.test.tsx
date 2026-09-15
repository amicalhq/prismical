// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NoteFolderChip } from './note-folder-chip';

const folders = [
  { id: 'fld_a', name: 'Projects', parentId: null, createdAt: '2026-01-01' },
  { id: 'fld_b', name: 'Projects', parentId: null, createdAt: '2026-01-02' },
  { id: 'fld_shared', name: 'Sales', parentId: null, createdAt: '2026-01-03', memberCount: 2 },
];
vi.mock('@prismical/app-client', () => ({
  useFolders: () => ({ data: folders }),
  folderById: (all: typeof folders, id: string) => all.find(folder => folder.id === id),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('selects the second same-named folder with the keyboard', () => {
  const onChange = vi.fn();
  render(<NoteFolderChip value={null} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'notes.folders.add' }));
  const input = screen.getByRole('combobox');
  fireEvent.change(input, { target: { value: 'Projects' } });
  expect(screen.getAllByRole('option')).toHaveLength(2);
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onChange).toHaveBeenCalledWith('fld_b');
});

it('asks before moving a note out of a shared folder, and moves on confirm', () => {
  const onChange = vi.fn();
  render(<NoteFolderChip value="fld_shared" onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'notes.folders.change' }));
  const input = screen.getByRole('combobox');
  fireEvent.change(input, { target: { value: 'Projects' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('dialogs.moveOutOfShared.confirm'));
  expect(onChange).toHaveBeenCalledWith('fld_a');
});
