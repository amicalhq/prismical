// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import { buildWebEditorExtensions } from './editor-extensions';
import { subscribeEditorHistory, withEditorHistoryBoundary } from './editor-history';
import {
  applyPreparedSkillResult,
  prepareSkillResultUpdate,
  wasSkillResultApplied,
} from './diff/skill-result-application';
import { useSkillDiffStore, type SkillDiffCandidate } from './diff/skill-diff-store';

document.elementFromPoint = () => null;

const instances: Array<{ doc: Y.Doc; editor: Editor }> = [];
function create(from?: Y.Doc, blocked?: () => boolean) {
  const doc = new Y.Doc();
  if (from) Y.applyUpdate(doc, Y.encodeStateAsUpdate(from));
  const editor = new Editor({ extensions: buildWebEditorExtensions(doc, 'note', '', blocked) });
  const instance = { doc, editor };
  instances.push(instance);
  return instance;
}
function manager(editor: Editor): Y.UndoManager {
  return yUndoPluginKey.getState(editor.state).undoManager;
}
afterEach(() => {
  instances.splice(0).forEach(({ editor, doc }) => {
    editor.destroy();
    doc.destroy();
  });
  useSkillDiffStore.getState().clear('note');
  vi.useRealTimers();
});

it('groups consecutive typing within 500ms, supports multiple steps, and clears redo on a new edit', async () => {
  const { editor } = create();
  editor.commands.insertContent('a');
  editor.commands.insertContent('b');
  expect(manager(editor).undoStack).toHaveLength(1);
  await new Promise(resolve => setTimeout(resolve, 550));
  editor.commands.insertContent('c');
  expect(manager(editor).undoStack).toHaveLength(2);
  expect(editor.commands.undo()).toBe(true);
  expect(editor.getText()).toBe('ab');
  expect(editor.commands.undo()).toBe(true);
  expect(editor.getText()).toBe('');
  expect(editor.commands.redo()).toBe(true);
  expect(editor.getText()).toBe('ab');
  expect(editor.commands.redo()).toBe(true);
  expect(editor.getText()).toBe('abc');
  editor.commands.undo();
  editor.commands.insertContent('x');
  expect(editor.can().redo()).toBe(false);
});

it.each(['saved', 'legacy'] as const)(
  'captures a %s AI application from the private host as one visible undo step',
  path => {
    const visible = create();
    visible.editor.commands.insertContent('Before');
    const host = create(visible.doc);
    const forward = (bytes: Uint8Array) => Y.applyUpdate(host.doc, bytes, 'proposal-source');
    visible.doc.on('update', forward);
    const append = (draft: Editor) =>
      draft.commands.insertContentAt(draft.state.doc.content.size, '<p>AI section</p>');
    const apply = {
      saved: () =>
        applyPreparedSkillResult(
          host.editor,
          prepareSkillResultUpdate(host.editor, 'result', append),
          visible.editor
        ),
      legacy: () =>
        withEditorHistoryBoundary(host.editor, () => append(host.editor), visible.editor),
    };
    apply[path]();
    expect(visible.editor.getText()).toBe('Before\n\nAI section');
    expect(host.editor.getJSON()).toEqual(visible.editor.getJSON());
    visible.editor.commands.insertContentAt(1, 'After ');
    expect(manager(visible.editor).undoStack).toHaveLength(3);
    expect(visible.editor.commands.undo()).toBe(true);
    expect(visible.editor.getText()).toBe('Before\n\nAI section');
    expect(visible.editor.commands.undo()).toBe(true);
    expect(visible.editor.getText()).toBe('Before');
    expect(visible.editor.commands.redo()).toBe(true);
    expect(visible.editor.getText()).toBe('Before\n\nAI section');
    expect(visible.editor.commands.redo()).toBe(true);
    expect(visible.editor.getText()).toBe('After Before\n\nAI section');
    visible.doc.off('update', forward);
  }
);

it('preserves remote text on local undo and hydrates saved body without history', () => {
  const local = create();
  local.editor.commands.insertContent('Shared');
  manager(local.editor).clear();
  const remote = create(local.doc);
  local.editor.commands.insertContentAt(1, 'Local ');
  remote.editor.commands.insertContentAt(remote.editor.state.doc.content.size - 1, ' remote');
  Y.applyUpdate(local.doc, Y.encodeStateAsUpdate(remote.doc), 'provider');
  expect(local.editor.getText()).toBe('Local Shared remote');
  local.editor.commands.undo();
  expect(local.editor.getText()).toBe('Shared remote');
  const reopened = create(local.doc);
  expect(reopened.editor.getText()).toBe('Shared remote');
  expect(reopened.editor.can().undo()).toBe(false);
  expect(reopened.editor.can().redo()).toBe(false);
});

it('guards commands and shortcuts during review, applying and read-only states', () => {
  let applying = false;
  const { editor } = create(undefined, () => applying);
  editor.commands.insertContent('Keep');
  useSkillDiffStore.getState().stage({ noteId: 'note' } as SkillDiffCandidate);
  expect(editor.can().undo()).toBe(false);
  expect(editor.commands.undo()).toBe(false);
  editor.commands.keyboardShortcut('Mod-z');
  expect(editor.getText()).toBe('Keep');
  useSkillDiffStore.getState().clear('note');
  applying = true;
  expect(editor.commands.undo()).toBe(false);
  applying = false;
  editor.setEditable(false);
  expect(editor.commands.undo()).toBe(false);
  editor.setEditable(true);
  expect(editor.commands.undo()).toBe(true);
  applying = true;
  expect(editor.commands.redo()).toBe(false);
  editor.commands.keyboardShortcut('Mod-y');
  editor.commands.keyboardShortcut('Shift-Mod-z');
  expect(editor.getText()).toBe('');
});

it('notifies after stack clearing and final pops, and unsubscribes', () => {
  const { editor } = create();
  const states: boolean[] = [];
  const stop = subscribeEditorHistory(editor, () => states.push(editor.can().undo()));
  editor.commands.insertContent('text');
  expect(states.at(-1)).toBe(true);
  editor.commands.undo();
  expect(states.at(-1)).toBe(false);
  editor.commands.redo();
  expect(states.at(-1)).toBe(true);
  manager(editor).clear();
  expect(states.at(-1)).toBe(false);
  stop();
  states.length = 0;
  editor.commands.insertContent('more');
  expect(states).toEqual([]);
});

it('keeps the application receipt after body undo so retry cannot revive undone AI text', () => {
  const visible = create();
  const host = create(visible.doc);
  const update = prepareSkillResultUpdate(host.editor, 'result', draft =>
    draft.commands.setContent('<p>AI</p>')
  );
  applyPreparedSkillResult(host.editor, update, visible.editor);
  visible.editor.commands.undo();
  expect(visible.editor.getText()).toBe('');
  expect(wasSkillResultApplied(visible.editor, 'result')).toBe(true);
  applyPreparedSkillResult(visible.editor, update);
  expect(visible.editor.getText()).toBe('');
});

it.each(['saved', 'legacy'] as const)(
  'keeps host-only collaborator edits outside %s AI undo',
  path => {
    const visible = create();
    visible.editor.commands.insertContent('Shared');
    manager(visible.editor).clear();
    const host = create(visible.doc);
    host.editor.commands.insertContentAt(host.editor.state.doc.content.size - 1, ' collaborator');
    const append = (draft: Editor) =>
      draft.commands.insertContentAt(draft.state.doc.content.size, '<p>AI</p>');
    const apply = {
      saved: () =>
        applyPreparedSkillResult(
          host.editor,
          prepareSkillResultUpdate(host.editor, 'result', append),
          visible.editor
        ),
      legacy: () =>
        withEditorHistoryBoundary(host.editor, () => append(host.editor), visible.editor),
    };
    apply[path]();
    expect(visible.editor.getText()).toBe('Shared collaborator\n\nAI');
    expect(visible.editor.commands.undo()).toBe(true);
    expect(visible.editor.getText()).toBe('Shared collaborator');
    expect(visible.editor.can().undo()).toBe(false);
  }
);
