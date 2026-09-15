// @vitest-environment jsdom
import * as React from 'react';
import { Editor, EditorContent } from '@tiptap/react';
import { buildEditorExtensions } from '../../../editor-schema/src';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useSkillDiffStore } from '../../../app-client/src/notes/diff/skill-diff-store';
const request = vi.hoisted(() => vi.fn());
vi.mock('@prismical/app-client', async () => ({
  ...(await import('../../../app-client/src/event-time')),
  useSkillDiffStore,
  usePorts: () => ({ analytics: {} }),
  useSkillsList: () => ({
    data: [
      {
        id: 'shorten',
        name: 'Shorten',
        enabled: true,
        config: { surface: ['inline'], outputTarget: 'note-body' },
      },
    ],
  }),
  useSkillRunActive: () => false,
  captureSelectionAnchors: () => ({ relFrom: { type: 'start' }, relTo: { type: 'end' } }),
  useInlineRunStore: (select: (state: unknown) => unknown) => select({ requestInlineRun: request }),
}));
vi.mock('react-i18next', () => {
  const t = (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key;
  return { useTranslation: () => ({ t }) };
});
const { useRegisterNoteDockActions } = await import('./note-dock-actions');
const { NoteSlashMenu } = await import('./note-slash-menu');
const { NoteFormattingToolbar } = await import('./note-formatting-toolbar');
const editors: Editor[] = [];
beforeAll(() => {
  const rect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    bottom: 20,
    right: 100,
    width: 100,
    height: 20,
    toJSON() {},
  });
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = () => [rect()] as unknown as DOMRectList;
  HTMLElement.prototype.scrollIntoView = () => {};
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  editors.splice(0).forEach(editor => editor.destroy());
  useSkillDiffStore.setState({ candidatesByNote: new Map() });
  request.mockClear();
});
function setup(content = '<p></p>') {
  const editor = new Editor({ extensions: buildEditorExtensions(), content });
  editors.push(editor);
  render(
    <>
      <EditorContent editor={editor} />
      <NoteSlashMenu editor={editor} noteId="note" />
      <NoteFormattingToolbar editor={editor} noteId="note" />
    </>
  );
  act(() => {
    editor.commands.focus();
  });
  return editor;
}
it('handles Enter before the default paragraph keymap and removes the query', async () => {
  const editor = setup();
  act(() => {
    editor.commands.insertContent('/h2');
  });
  await screen.findByText('Heading 2');
  fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
  await waitFor(() => expect(editor.state.doc.firstChild?.type.name).toBe('heading'));
  expect(editor.getText().trim()).toBe('');
  expect(screen.queryByText('Heading 2')).toBeNull();
});
it('navigates the slash results with arrows and dismisses with Escape without deleting text', async () => {
  const editor = setup();
  act(() => {
    editor.commands.insertContent('/');
  });
  await screen.findByText('Heading 1');
  fireEvent.keyDown(editor.view.dom, { key: 'ArrowDown' });
  fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
  await waitFor(() => expect(editor.state.doc.firstChild?.attrs.level).toBe(1));
  act(() => {
    editor.commands.setContent('<p></p>');
    editor.commands.insertContent('/h');
  });
  await screen.findByText('Heading 2');
  fireEvent.keyDown(editor.view.dom, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByText('Heading 2')).toBeNull());
  expect(editor.getText()).toBe('/h');
});
it('does not interpret a slash inside normal text as a command', async () => {
  const editor = setup('<p>path</p>');
  act(() => {
    editor.commands.setTextSelection(5);
    editor.commands.insertContent('/h2');
  });
  await act(async () => {});
  expect(screen.queryByText('Heading 2')).toBeNull();
  expect(editor.getText()).toBe('path/h2');
});
it('keeps formatting available across paragraphs while hiding single-block skills', async () => {
  const editor = setup('<p>First</p><p>Second</p>');
  act(() => {
    editor.commands.setTextSelection({ from: 1, to: 14 });
  });
  const bold = await screen.findByRole('button', { name: 'Bold' });
  expect(screen.queryByRole('button', { name: 'Skills' })).toBeNull();
  fireEvent.click(bold);
  expect(editor.getHTML()).toBe('<p><strong>First</strong></p><p><strong>Second</strong></p>');
});
it('hides editing controls when a candidate becomes staged', async () => {
  const editor = setup('<p>Selected text</p>');
  act(() => {
    editor.commands.setTextSelection({ from: 1, to: 9 });
  });
  await screen.findByRole('button', { name: 'Bold' });
  act(() => useSkillDiffStore.setState({ candidatesByNote: new Map([['note', {} as never]]) }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Bold' })).toBeNull());
});
it('keeps the selected words when focus moves into the link input', async () => {
  const editor = setup('<p>Selected words and other text</p>');
  act(() => {
    editor.commands.setTextSelection({ from: 1, to: 15 });
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Edit link' }));
  const input = await screen.findByRole('textbox', { name: 'Link URL' });
  fireEvent.change(input, { target: { value: 'example.com' } });
  fireEvent.submit(screen.getByRole('form', { name: 'Edit link' }));
  expect(editor.getHTML()).toContain('href="https://example.com"');
  expect(editor.getHTML()).toContain('>Selected words</a> and other text');
});
it('runs the existing inline skill on the selection through the dropdown', async () => {
  const editor = setup('<p>Selected words and other text</p>');
  act(() => {
    editor.commands.setTextSelection({ from: 1, to: 16 });
  });
  const trigger = await screen.findByRole('button', { name: 'Skills' });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Shorten' }));
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      skillId: 'shorten',
      selectionText: 'Selected words',
      selectionAnchors: expect.any(Object),
      noteMarkdown: 'Selected words and other text',
    }),
    expect.any(Object)
  );
  expect(editor.getText()).toBe('Selected words and other text');
});
it('hides formatting when edit permission is revoked', async () => {
  const editor = setup('<p>Selected text</p>');
  act(() => {
    editor.commands.setTextSelection({ from: 1, to: 9 });
  });
  await screen.findByRole('button', { name: 'Bold' });
  act(() => editor.setEditable(false));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Bold' })).toBeNull());
});
it('offers formatting for Select All without offering single-block skills', async () => {
  const editor = setup('<p>First</p><p>Second</p>');
  act(() => {
    editor.commands.selectAll();
  });
  await screen.findByRole('button', { name: 'Bold' });
  expect(screen.queryByRole('button', { name: 'Skills' })).toBeNull();
});

function DockActionFixture({
  startRecording,
  askAi,
}: {
  startRecording?: () => void;
  askAi?: () => void;
}) {
  const actions = React.useMemo(() => ({ startRecording, askAi }), [startRecording, askAi]);
  useRegisterNoteDockActions('note', actions);
  return null;
}
it('puts recording and Ask AI first, removing the trigger before handing off', async () => {
  const start = vi.fn();
  const ask = vi.fn();
  render(<DockActionFixture startRecording={start} askAi={ask} />);
  const editor = setup();
  act(() => {
    editor.commands.insertContent('/');
  });
  await screen.findByText('Start recording');
  expect(
    screen
      .getAllByRole('option')
      .slice(0, 3)
      .map(item => item.textContent)
  ).toEqual(['Start recording', 'Ask AI', 'Text']);
  fireEvent.keyDown(editor.view.dom, { key: 'ArrowDown' });
  fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
  expect(ask).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
  expect(editor.getText().trim()).toBe('');
  act(() => {
    editor.commands.insertContent('/record');
  });
  await screen.findByText('Start recording');
  fireEvent.click(screen.getByText('Start recording'));
  expect(start).toHaveBeenCalledOnce();
  expect(editor.getText().trim()).toBe('');
});
it('removes stale dock actions when the dock unmounts', async () => {
  const ask = vi.fn();
  const dock = render(<DockActionFixture askAi={ask} />);
  const editor = setup();
  act(() => {
    editor.commands.insertContent('/ask');
  });
  await screen.findByText('Ask AI');
  dock.unmount();
  expect(screen.queryByRole('option', { name: 'Ask AI' })).toBeNull();
  fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
  expect(ask).not.toHaveBeenCalled();
});
