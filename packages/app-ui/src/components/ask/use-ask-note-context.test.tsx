// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAskNoteContext, type AskNoteContext } from './use-ask-note-context';

const noteA = { id: 'note_a', title: 'Cedar plan' };
const noteB = { id: 'note_b', title: 'Birch plan' };
afterEach(cleanup);

function setup(note: AskNoteContext | null = noteA) {
  return renderHook(({ note, owner }) => useAskNoteContext(note, owner), {
    initialProps: { note, owner: 'account:organization' },
  });
}

describe('Ask current-note context', () => {
  it('seeds the open note and combines explicit mentions without duplicate IDs', () => {
    const { result } = setup();
    expect(result.current.focusNote).toEqual(noteA);
    expect(result.current.resolveNotes()).toEqual([noteA]);
    expect(result.current.resolveNotes([noteB, noteA, noteB])).toEqual([noteA, noteB]);
  });

  it('keeps removal through rerenders and title changes, while explicit mentions still work', () => {
    const { result, rerender } = setup();
    act(() => result.current.remove());
    rerender({ note: { ...noteA, title: 'Renamed plan' }, owner: 'account:organization' });
    expect(result.current.focusNote).toBeNull();
    expect(result.current.resolveNotes()).toEqual([]);
    expect(result.current.resolveNotes([noteB])).toEqual([noteB]);
    expect(result.current.resolveNotes([noteA])).toEqual([noteA]);
    act(() => result.current.restore());
    expect(result.current.focusNote?.title).toBe('Renamed plan');
  });

  it('starts a fresh automatic selection on each note visit, including leaving and returning', () => {
    const { result, rerender } = setup();
    act(() => result.current.remove());
    rerender({ note: noteB, owner: 'account:organization' });
    expect(result.current.resolveNotes()).toEqual([noteB]);
    rerender({ note: null, owner: 'account:organization' });
    expect(result.current.focusNote).toBeNull();
    expect(result.current.resolveNotes()).toEqual([]);
    rerender({ note: noteA, owner: 'account:organization' });
    expect(result.current.resolveNotes()).toEqual([noteA]);
  });

  it('does not rewrite the context snapshot of a send when navigation changes', () => {
    const { result, rerender } = setup();
    const sentNotes = result.current.resolveNotes();
    rerender({ note: noteB, owner: 'account:organization' });
    expect(sentNotes).toEqual([noteA]);
    expect(result.current.resolveNotes()).toEqual([noteB]);
  });

  it('resets the visit decision when the owning session or organization changes', () => {
    const { result, rerender } = setup();
    act(() => result.current.remove());
    rerender({ note: noteA, owner: 'account:other-organization' });
    expect(result.current.resolveNotes()).toEqual([noteA]);
    act(() => result.current.remove());
    rerender({ note: noteA, owner: 'other-account:other-organization' });
    expect(result.current.resolveNotes()).toEqual([noteA]);
  });
});
