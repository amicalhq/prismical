// @vitest-environment jsdom
import { Editor } from '@tiptap/react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { buildEditorExtensions } from '../../../editor-schema/src';
import { CurrentEditorProvider, useCurrentNoteEditor } from '../shell/current-editor-context';
import { useNoteBodyEmpty } from './use-note-body-empty';

const editors: Editor[] = [];
afterEach(() => {
  cleanup();
  editors.splice(0).forEach(editor => editor.destroy());
});
function create(content: string) {
  const editor = new Editor({ extensions: buildEditorExtensions(), content });
  editors.push(editor);
  return editor;
}

it('reads the current note immediately when its editor registers, changes, or unmounts', () => {
  const empty = create('<p></p>');
  const populated = create('<p>Existing notes</p>');
  const { result, rerender } = renderHook(({ noteId }) => ({
    empty: useNoteBodyEmpty(noteId),
    context: useCurrentNoteEditor(),
  }), { initialProps: { noteId: 'note_a' }, wrapper: CurrentEditorProvider });

  expect(result.current.empty).toBeNull();
  act(() => result.current.context.setActiveEditor('note_a', empty));
  expect(result.current.empty).toBe(true);
  act(() => result.current.context.setActiveEditor('note_b', populated));
  expect(result.current.empty).toBeNull();
  rerender({ noteId: 'note_b' });
  expect(result.current.empty).toBe(false);
  act(() => result.current.context.setActiveEditor('note_b', empty));
  expect(result.current.empty).toBe(true);
  act(() => empty.commands.setContent('<p>Typed notes</p>'));
  expect(result.current.empty).toBe(false);
  act(() => empty.commands.setContent('<p>   </p>'));
  expect(result.current.empty).toBe(true);
  act(() => result.current.context.clearActiveEditor('note_b'));
  expect(result.current.empty).toBeNull();
});

it('returns unknown outside an editor host', () => {
  const { result } = renderHook(() => useNoteBodyEmpty('note_a'));
  expect(result.current).toBeNull();
});
