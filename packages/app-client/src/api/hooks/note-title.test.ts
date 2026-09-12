// @vitest-environment jsdom
import { observable, syncState } from '@legendapp/state';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteRow, SyncStore } from '../../sync/store';

const mocks = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('../../sync/provider', () => ({ useSyncStore: () => mocks.store }));
import { listResult, useFreezeNoteTitle, useNote } from './notes';

const updateNote = vi.fn();
let notes$: ReturnType<typeof observable<Record<string, NoteRow>>>;
beforeEach(() => {
  updateNote.mockReset();
  notes$ = observable<Record<string, NoteRow>>({
    nt_test: {
      id: 'nt_test',
      title: 'First line',
      titleSource: 'first-line',
      titleRevision: 3,
      updatedAt: '2030-01-01',
    },
  });
  mocks.store = { notes$, updateNote };
});

describe('useFreezeNoteTitle', () => {
  it('queues the latest editor title with its current naming revision', () => {
    const { result } = renderHook(() => useFreezeNoteTitle('nt_test'));
    result.current(' Finished title ');
    expect(updateNote).toHaveBeenCalledWith('nt_test', {
      title: 'Finished title',
      titleIntent: 'freeze',
      titleExpectedRevision: 3,
    });
  });
  it.each(['manual', 'ai', 'calendar', 'imported', 'first-line-fixed'])(
    'checks live %s provenance at departure',
    source => {
      const { result } = renderHook(() => useFreezeNoteTitle('nt_test'));
      notes$.nt_test!.titleSource.set(source);
      result.current('Stale first line');
      expect(updateNote).not.toHaveBeenCalled();
    }
  );
  it('does not settle empty, read-only, or removed notes', () => {
    const { result } = renderHook(() => useFreezeNoteTitle('nt_test'));
    result.current(' ');
    notes$.nt_test!.canWrite.set(false);
    result.current('First line');
    notes$.nt_test!.delete();
    result.current('First line');
    expect(updateNote).not.toHaveBeenCalled();
  });
});

it('treats an empty hydrated collection as usable while its first pull is pending or offline', () => {
  const store = { refreshAll: vi.fn() } as unknown as SyncStore;
  const read = listResult(store, {}, { isLoaded: false, error: new Error('Offline') }, row => row);
  expect(read).toMatchObject({ data: [], isLoading: false, isSuccess: true, error: undefined });
  expect(listResult(null, undefined, null, row => row).isLoading).toBe(true);
});

it('keeps an uncached note detail loading until the initial server lookup settles', () => {
  notes$ = observable<Record<string, NoteRow>>({});
  syncState(notes$).isLoaded.set(false);
  mocks.store = { notes$, noteTags$: observable({}), noteEvents$: observable({}), refreshAll: vi.fn() };
  const { result } = renderHook(() => useNote('nt_remote'));
  expect(result.current.isLoading).toBe(true);
  act(() => syncState(notes$).isLoaded.set(true));
  expect(result.current.isLoading).toBe(false);
});
