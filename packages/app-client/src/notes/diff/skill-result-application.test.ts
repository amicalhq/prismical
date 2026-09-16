// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { buildWebEditorExtensions } from '../editor-extensions';
import { registerNoteDelivery } from "../note-delivery";
import { isGenuinelyEmptyNote, waitForSkillResultDelivery, prepareSkillResultUpdate, applyPreparedSkillResult, wasSkillResultApplied } from './skill-result-application';

beforeAll(() => { document.elementFromPoint = () => null; });

describe('saved suggestion application updates', () => {
  it('waits for registered persistence and fails closed after the connection unmounts', async () => {
    const doc = new Y.Doc();
    const editor = new Editor({ extensions: buildWebEditorExtensions(doc, '', '') });
    await expect(waitForSkillResultDelivery(editor)).rejects.toThrow('unavailable');
    let complete!: () => void;
    const persisted = vi.fn();
    const unregister = registerNoteDelivery(doc, () => new Promise<void>(resolve => { complete = resolve; }));
    const pending = waitForSkillResultDelivery(editor).then(persisted);
    await Promise.resolve();
    expect(persisted).not.toHaveBeenCalled();
    complete();
    await pending;
    expect(persisted).toHaveBeenCalledOnce();
    unregister();
    await expect(waitForSkillResultDelivery(editor)).rejects.toThrow('unavailable');
    editor.destroy(); doc.destroy();
  });

  it('applies the same committed append once across clients and after reopening', () => {
    const source = new Y.Doc();
    const first = new Editor({ extensions: buildWebEditorExtensions(source, '', '') });
    first.commands.setContent('<p>Scratch notes remain.</p>');
    const secondDoc = new Y.Doc();
    Y.applyUpdate(secondDoc, Y.encodeStateAsUpdate(source));
    const second = new Editor({ extensions: buildWebEditorExtensions(secondDoc, '', '') });
    const update = prepareSkillResultUpdate(first, 'result', draft =>
      draft.commands.insertContentAt(draft.state.doc.content.size, '<p>Generated section.</p>'));
    expect(first.getText()).toBe('Scratch notes remain.');
    applyPreparedSkillResult(first, update);
    applyPreparedSkillResult(second, update);
    Y.applyUpdate(source, Y.encodeStateAsUpdate(secondDoc));
    Y.applyUpdate(secondDoc, Y.encodeStateAsUpdate(source));
    applyPreparedSkillResult(second, update);
    expect(first.getText()).toBe('Scratch notes remain.\n\nGenerated section.');
    expect(second.getJSON()).toEqual(first.getJSON());
    expect(wasSkillResultApplied(second, 'result')).toBe(true);
    const reopenedDoc = new Y.Doc();
    Y.applyUpdate(reopenedDoc, Y.encodeStateAsUpdate(source));
    const reopened = new Editor({ extensions: buildWebEditorExtensions(reopenedDoc, '', '') });
    applyPreparedSkillResult(reopened, update);
    expect(reopened.getJSON()).toEqual(first.getJSON());
    expect(wasSkillResultApplied(reopened, 'result')).toBe(true);
    first.destroy(); second.destroy(); reopened.destroy();
    source.destroy(); secondDoc.destroy(); reopenedDoc.destroy();
  });

  it('keeps the accepted operation undoable without reviving its application', () => {
    const doc = new Y.Doc();
    const editor = new Editor({ extensions: buildWebEditorExtensions(doc, '', '') });
    editor.commands.setContent('<p>Original scratch.</p>');
    const update = prepareSkillResultUpdate(editor, 'result', draft => draft.commands.setContent('<p>Cleaned text.</p>'));
    applyPreparedSkillResult(editor, update);
    expect(editor.getText()).toBe('Cleaned text.');
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getText()).toBe('Original scratch.');
    expect(wasSkillResultApplied(editor, 'result')).toBe(true);
    applyPreparedSkillResult(editor, update);
    expect(editor.getText()).toBe('Original scratch.');
    editor.destroy(); doc.destroy();
  });

  it('delivers scratch dependencies with the committed update and preserves later edits', () => {
    const source = new Y.Doc();
    const first = new Editor({ extensions: buildWebEditorExtensions(source, '', '') });
    first.commands.setContent('<p>Unsynced scratch.</p>');
    const update = prepareSkillResultUpdate(first, 'result', draft =>
      draft.commands.insertContentAt(draft.state.doc.content.size, '<p>Generated section.</p>'));
    const destination = new Y.Doc();
    const second = new Editor({ extensions: buildWebEditorExtensions(destination, '', '') });
    applyPreparedSkillResult(second, update);
    expect(second.getText()).toContain('Unsynced scratch.');
    expect(second.getText()).toContain('Generated section.');
    second.commands.insertContentAt(second.state.doc.content.size, '<p>Later edit.</p>');
    applyPreparedSkillResult(second, update);
    expect(second.getText().match(/Generated section/g)).toHaveLength(1);
    expect(second.getText()).toContain('Later edit.');
    first.destroy(); second.destroy(); source.destroy(); destination.destroy();
  });
});


describe('genuinely empty note eligibility', () => {
  it.each([
    { type: 'doc', content: [] },
    { type: 'doc', content: [{ type: 'paragraph' }] },
    { type: 'doc', content: [{ type: 'paragraph' }, { type: 'paragraph' }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: ' \t\n\u00a0' }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'hardBreak' }] }] },
    { type: 'doc', content: [{ type: 'paragraph' }, { type: 'paragraph', content: [
      { type: 'text', text: ' ', marks: [{ type: 'bold' }] }, { type: 'hardBreak' },
    ] }] },
  ])('admits an empty document %j', doc => { expect(isGenuinelyEmptyNote(doc)).toBe(true); });
  it.each([
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Scratch' }] }] },
    { type: 'doc', content: [{ type: 'paragraph' }, { type: 'paragraph', content: [{ type: 'text', text: ' x ' }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { src: 'image' } }] }] },
    { type: 'doc', content: [{ type: 'heading' }] },
    { type: 'doc', content: [{ type: 'image', attrs: { src: 'image' } }] },
    { type: 'doc', content: [{ type: 'artifactBlock' }] },
    { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }] },
  ])('keeps existing content in review %j', doc => { expect(isGenuinelyEmptyNote(doc)).toBe(false); });
});
