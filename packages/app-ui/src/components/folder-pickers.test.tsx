// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NotesFolderPicker } from './notes-folder-picker';
import { NoteFolderChip } from './note-folder-chip';

const folders = [
  { id: 'fld_a', name: 'Projects', parentId: null, createdAt: '2026-01-01' },
  { id: 'fld_b', name: 'Projects', parentId: null, createdAt: '2026-01-02' },
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
it.each([
  ['filter', NotesFolderPicker, 'notes.folders.filter'],
  ['assignment', NoteFolderChip, 'notes.folders.add'],
] as const)(
  'selects the second same-named folder with keyboard in %s',
  (_name, Picker, trigger) => {
    const onChange = vi.fn();
    render(<Picker value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: trigger }));
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Projects' } });
    expect(screen.getAllByRole('option')).toHaveLength(2);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('fld_b');
  }
);
