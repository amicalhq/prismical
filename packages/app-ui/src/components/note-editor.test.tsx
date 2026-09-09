// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markdownToTiptapJson } from '@prismical/editor-markdown';
import type { Note } from '@prismical/app-contracts';
import { NoteEditor } from './note-editor';

const harness = vi.hoisted(() => ({
  editor: null as null | { getJSON: ReturnType<typeof vi.fn>; isDestroyed: boolean },
  editorNoteId: 'note_a',
  copy: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { success: harness.success, error: harness.error } }));
vi.mock('../lib/clipboard', () => ({ copyToClipboard: harness.copy }));
vi.mock('@prismical/app-client', () => ({
  useDesktopCapabilities: () => ({ has: () => false }),
  useEntitlements: () => ({ entitlements: { features: {} } }),
  useFeatureFlag: () => ({ enabled: false }),
  useNavigation: () => ({}),
  useUpdateNote: () => ({ mutate: vi.fn() }),
  useDeleteNote: () => ({ mutate: vi.fn() }),
}));
vi.mock('../shell/current-note-context', () => ({ useRegisterCurrentNote: () => {} }));
vi.mock('../shell/current-editor-context', () => ({ useCurrentNoteEditor: () => harness }));
vi.mock('./note-body-editor', () => ({ NoteBodyEditor: () => null }));
vi.mock('./note-title-field', () => ({ NoteTitleField: () => null }));
vi.mock('./note-folder-chip', () => ({ NoteFolderChip: () => null }));
vi.mock('./note-tag-editor', () => ({ NoteTagEditor: () => null }));
vi.mock('./note-event-chips', () => ({ NoteEventChips: () => null }));
vi.mock('../shell/share-dialog', () => ({ ShareDialog: () => null }));
// Keep the menu action available without depending on portal/focus behavior in jsdom.
vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => children,
  DropdownMenuItem: ({ children, onSelect, disabled }: {
    children: ReactNode; onSelect: () => void; disabled?: boolean;
  }) => <button disabled={disabled} onClick={onSelect}>{children}</button>,
}));
const note = { id: 'note_a', title: 'Title', body: 'Stale metadata body', tagIds: [] } as unknown as Note;
const copy = () => fireEvent.click(screen.getByRole('button', { name: 'notes.actions.copyMarkdown' }));

describe('note markdown copy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.editorNoteId = note.id;
    harness.editor = { isDestroyed: false, getJSON: vi.fn(() => markdownToTiptapJson('Initial body')) };
    harness.copy.mockResolvedValue(true);
  });
  afterEach(cleanup);

  it('copies formatted live content at click time instead of stale metadata', async () => {
    render(<NoteEditor note={note} />);
    harness.editor!.getJSON.mockReturnValue(markdownToTiptapJson('## Latest\n\nA **bold** edit.\n\n- item'));
    copy();
    await waitFor(() => expect(harness.copy).toHaveBeenCalledWith('# Title\n\n## Latest\n\nA **bold** edit.\n\n- item'));
    expect(harness.success).toHaveBeenCalledOnce();
  });

  it.each(['loading', 'other note', 'destroyed'])('disables copy for an unavailable editor: %s', state => {
    harness.editor = state === 'loading' ? null : harness.editor;
    harness.editorNoteId = state === 'other note' ? 'note_b' : note.id;
    Object.assign(harness.editor ?? {}, { isDestroyed: state === 'destroyed' });
    render(<NoteEditor note={note} />);
    expect(screen.getByRole('button', { name: 'notes.actions.copyMarkdown' }).hasAttribute('disabled')).toBe(true);
    copy();
    expect(harness.copy).not.toHaveBeenCalled();
  });

  it('copies an empty loaded note without falling back to stale text', async () => {
    harness.editor!.getJSON.mockReturnValue(markdownToTiptapJson(''));
    render(<NoteEditor note={note} />);
    copy();
    await waitFor(() => expect(harness.copy).toHaveBeenCalledWith('# Title\n\n'));
  });

  it('reports clipboard failure without claiming success', async () => {
    harness.copy.mockResolvedValue(false);
    render(<NoteEditor note={note} />);
    copy();
    await waitFor(() => expect(harness.error).toHaveBeenCalledOnce());
    expect(harness.success).not.toHaveBeenCalled();
  });

  it('reports serialization errors without copying partial content', async () => {
    harness.editor!.getJSON.mockImplementation(() => { throw new Error('Unavailable document'); });
    render(<NoteEditor note={note} />);
    copy();
    await waitFor(() => expect(harness.error).toHaveBeenCalledOnce());
    expect(harness.copy).not.toHaveBeenCalled();
  });
});
