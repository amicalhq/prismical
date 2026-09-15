// @vitest-environment jsdom
import { Editor } from '@tiptap/react';
import { buildWebEditorExtensions } from '../../../app-client/src/notes/editor-extensions';
import { buildEditorExtensions } from '../../../editor-schema/src';
import * as Y from 'yjs';
import { yUndoPluginKey } from '../../../app-client/node_modules/@tiptap/y-tiptap';
Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
import { afterEach, expect, it } from 'vitest';
import {
  applyBlock,
  noteBlockActions,
  normalizeEditorLink,
  supportsInlineSkill,
} from './note-editor-actions';

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach(editor => editor.destroy()));
function create(content: string) {
  const editor = new Editor({ extensions: buildEditorExtensions(), content });
  editors.push(editor);
  return editor;
}

it.each(noteBlockActions)('inserts $label without leaving the slash query behind', action => {
  const editor = create('<p>/he</p>');
  editor.commands.setTextSelection(4);
  expect(applyBlock(editor, action, { from: 1, to: 4 })).toBe(true);
  expect(editor.getText()).not.toContain('/he');
  const expected = action.id.startsWith('heading')
    ? 'heading'
    : action.id === 'divider'
      ? 'horizontalRule'
      : action.id;
  expect(JSON.stringify(editor.getJSON())).toContain(`"type":"${expected}"`);
});
it('keeps trailing text and supports undo after converting a slash query', () => {
  const editor = create('<p>/h2 Remaining text</p>');
  editor.commands.setTextSelection(4);
  expect(applyBlock(editor, noteBlockActions[2], { from: 1, to: 4 })).toBe(true);
  expect(editor.state.doc.firstChild?.textContent).toBe(' Remaining text');
  expect(editor.commands.undo()).toBe(true);
  expect(editor.getHTML()).toBe('<p>/h2 Remaining text</p>');
});
it('formats multiple paragraphs while keeping inline skills restricted to one textblock', () => {
  const editor = create('<p>First</p><p>Second</p>');
  editor.commands.setTextSelection({ from: 1, to: 14 });
  expect(supportsInlineSkill(editor)).toBe(false);
  expect(editor.commands.toggleMark('bold')).toBe(true);
  expect(editor.getHTML()).toBe('<p><strong>First</strong></p><p><strong>Second</strong></p>');
  editor.commands.setTextSelection({ from: 1, to: 6 });
  expect(supportsInlineSkill(editor)).toBe(true);
});
it('refuses block changes in a read-only editor', () => {
  const editor = create('<p>Original</p>');
  editor.setEditable(false);
  expect(applyBlock(editor, noteBlockActions[1])).toBe(false);
  expect(editor.getHTML()).toBe('<p>Original</p>');
});
it('keeps block changes in the existing Yjs undo history', () => {
  const doc = new Y.Doc();
  const editor = new Editor({ extensions: buildWebEditorExtensions(doc, 'note', '') });
  editors.push(editor);
  editor.commands.setContent('<p>/h2</p>');
  // Split initial content from the user action in the collaboration undo manager.
  const undo = yUndoPluginKey.getState(editor.state).undoManager;
  undo?.stopCapturing();
  editor.commands.setTextSelection(4);
  expect(applyBlock(editor, noteBlockActions[2], { from: 1, to: 4 })).toBe(true);
  expect(editor.isActive('heading', { level: 2 })).toBe(true);
  expect(editor.commands.undo()).toBe(true);
  expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
  expect(editor.getText()).toBe('/h2');
  editor.destroy();
  editors.pop();
  doc.destroy();
});
it.each(['javascript:alert(1)', 'data:text/html,hello', 'https://bad host', 'vbscript:msgbox(1)'])(
  'rejects unsafe link %s',
  url => {
    expect(normalizeEditorLink(url)).toBeNull();
  }
);
it.each([
  ['example.com', 'https://example.com'],
  ['mailto:hello@example.com', 'mailto:hello@example.com'],
  ['', ''],
])('normalizes %s', (input, expected) => {
  expect(normalizeEditorLink(input)).toBe(expected);
});
