// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/react';
import * as Y from 'yjs';
import { buildWebEditorExtensions } from '../../../app-client/src/notes/editor-extensions';
import { subscribeEditorHistory } from '../../../app-client/src/notes/editor-history';
import {
  useSkillDiffStore,
  type SkillDiffCandidate,
} from '../../../app-client/src/notes/diff/skill-diff-store';
import { yUndoPluginKey } from '../../../app-client/node_modules/@tiptap/y-tiptap';
const state = vi.hoisted(() => ({ workflow: { kind: 'idle' } as Record<string, unknown> }));
vi.mock('@prismical/app-client', () => ({
  subscribeEditorHistory: (...args: Parameters<typeof subscribeEditorHistory>) =>
    subscribeEditorHistory(...args),
  useSkillDiffStore,
  useWorkflowSnapshot: () => state.workflow,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key.split('.').at(-1) }),
}));
const { NoteHistoryControls } = await import('./note-history-controls');
document.elementFromPoint = () => null;
const instances: Array<{ editor: Editor; doc: Y.Doc }> = [];
function create() {
  const doc = new Y.Doc();
  const editor = new Editor({ extensions: buildWebEditorExtensions(doc, 'note', '') });
  instances.push({ editor, doc });
  return editor;
}
afterEach(() => {
  cleanup();
  instances.splice(0).forEach(({ editor, doc }) => {
    editor.destroy();
    doc.destroy();
  });
  useSkillDiffStore.getState().clear('note');
  state.workflow = { kind: 'idle' };
});
const undo = () => screen.getByRole('button', { name: 'undo' }) as HTMLButtonElement;
const redo = () => screen.getByRole('button', { name: 'redo' }) as HTMLButtonElement;
it('reacts to the first edit, final undo/redo and explicit stack clearing', () => {
  const editor = create();
  render(<NoteHistoryControls editor={editor} noteId="note" writable />);
  expect(undo().disabled).toBe(true);
  expect(redo().disabled).toBe(true);
  act(() => {
    editor.commands.insertContent('One');
  });
  expect(undo().disabled).toBe(false);
  fireEvent.click(undo());
  expect(editor.getText()).toBe('');
  expect(undo().disabled).toBe(true);
  expect(redo().disabled).toBe(false);
  fireEvent.click(redo());
  expect(editor.getText()).toBe('One');
  expect(redo().disabled).toBe(true);
  act(() => {
    yUndoPluginKey.getState(editor.state).undoManager.clear();
  });
  expect(undo().disabled).toBe(true);
});
it('gates read-only, review, applying and destroyed editors', () => {
  const editor = create();
  editor.commands.insertContent('Keep');
  const view = render(<NoteHistoryControls editor={editor} noteId="note" writable />);
  expect(undo().disabled).toBe(false);
  act(() => editor.setEditable(false));
  expect(undo().disabled).toBe(true);
  act(() => editor.setEditable(true));
  act(() => useSkillDiffStore.getState().stage({ noteId: 'note' } as SkillDiffCandidate));
  expect(undo().disabled).toBe(true);
  act(() => useSkillDiffStore.getState().clear('note'));
  state.workflow = { kind: 'skill', noteId: 'note', phase: 'applying' };
  view.rerender(<NoteHistoryControls editor={editor} noteId="note" writable />);
  expect(undo().disabled).toBe(true);
  state.workflow = { kind: 'skill', noteId: 'other', phase: 'applying' };
  view.rerender(<NoteHistoryControls editor={editor} noteId="note" writable />);
  expect(undo().disabled).toBe(false);
  view.rerender(<NoteHistoryControls editor={editor} noteId="note" writable={false} />);
  expect(undo().disabled).toBe(true);
  act(() => editor.destroy());
  expect(undo().disabled).toBe(true);
});
it('switches subscriptions and never targets the previous note editor', () => {
  const first = create();
  const next = create();
  first.commands.insertContent('First');
  const view = render(<NoteHistoryControls editor={first} noteId="note" writable />);
  view.rerender(<NoteHistoryControls editor={null} noteId="next" writable />);
  expect(undo().disabled).toBe(true);
  view.rerender(<NoteHistoryControls editor={next} noteId="next" writable />);
  act(() => next.commands.insertContent('Next'));
  fireEvent.click(undo());
  expect(next.getText()).toBe('');
  expect(first.getText()).toBe('First');
});
