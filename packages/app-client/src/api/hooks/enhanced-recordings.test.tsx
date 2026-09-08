// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../sync/api', () => ({
  restList: vi.fn(async () => []),
  restCreate: vi.fn(),
  restUpdate: vi.fn(),
  restRemove: vi.fn(),
  restNoteTagList: vi.fn(async () => []),
  restNoteTagCreate: vi.fn(),
  restNoteTagRemove: vi.fn(),
  restNoteEventList: vi.fn(async () => []),
  restNoteEventCreate: vi.fn(),
  restNoteEventRemove: vi.fn(),
}));
vi.mock('../../sync/provider', () => ({ useSyncStore: vi.fn() }));
vi.mock('./skill-runs', () => ({ listEnhancedRecordingIds: vi.fn(async () => ['rec_kept']) }));

import * as api from '../../sync/api';
import { useSyncStore } from '../../sync/provider';
import { createSyncStore, type SyncStore } from '../../sync/store';
import { listEnhancedRecordingIds } from './skill-runs';
import { useEnhancedRecordings } from './transcripts';
import { ApiError } from '../client';

let store: SyncStore;
let client: QueryClient;
let releaseCreate: () => void;
function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listEnhancedRecordingIds).mockResolvedValue(['rec_kept']);
  vi.mocked(api.restCreate).mockImplementation(
    (_route, input) =>
      new Promise(resolve => {
        releaseCreate = () => resolve({ ...(input as object), createdAt: '2030-01-01T00:00:00.000Z' });
      })
  );
  store = createSyncStore({ partition: { accountSub: 'sub', orgId: 'org' }, pollIntervalMs: 0 });
  vi.mocked(useSyncStore).mockReturnValue(store);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  store.notes$.get();
});
afterEach(() => {
  cleanup();
  client.clear();
  store.dispose();
});
async function createPendingNote() {
  await waitFor(() => expect(api.restList).toHaveBeenCalled());
  const id = store.createNote({ title: 'New note' });
  await waitFor(() => expect(api.restCreate).toHaveBeenCalled());
  return id;
}

describe('enhanced recording history', () => {
  it('waits for the real sync store create acknowledgement before requesting history', async () => {
    const id = await createPendingNote();
    const { result } = renderHook(() => useEnhancedRecordings(id), { wrapper });
    expect(result.current.fetchStatus).toBe('fetching');
    expect(listEnhancedRecordingIds).not.toHaveBeenCalled();
    await act(async () => {
      releaseCreate();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listEnhancedRecordingIds).toHaveBeenCalledExactlyOnceWith(id);
    expect([...result.current.data!]).toEqual(['rec_kept']);
  });
  it('loads existing notes without waiting for a local create', async () => {
    const { result } = renderHook(() => useEnhancedRecordings('nt_existing'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listEnhancedRecordingIds).toHaveBeenCalledExactlyOnceWith('nt_existing');
  });
  it('does not dispatch the old note request after navigation cancels the wait', async () => {
    const id = await createPendingNote();
    const { result, rerender } = renderHook(({ noteId }) => useEnhancedRecordings(noteId), {
      wrapper,
      initialProps: { noteId: id },
    });
    rerender({ noteId: 'nt_existing' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      releaseCreate();
    });
    expect(listEnhancedRecordingIds).toHaveBeenCalledExactlyOnceWith('nt_existing');
  });
  it('does not dispatch after the identity cache is cleared', async () => {
    const id = await createPendingNote();
    renderHook(() => useEnhancedRecordings(id), { wrapper });
    client.clear();
    await act(async () => {
      releaseCreate();
    });
    expect(listEnhancedRecordingIds).not.toHaveBeenCalled();
  });
  it('cancels the old gate when an identity reset refetches with the replacement store', async () => {
    const id = await createPendingNote();
    const { result, rerender } = renderHook(() => useEnhancedRecordings(id), { wrapper });
    vi.mocked(useSyncStore).mockReturnValue(null);
    rerender();
    await act(async () => {
      await client.resetQueries();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      releaseCreate();
    });
    expect(listEnhancedRecordingIds).toHaveBeenCalledExactlyOnceWith(id);
  });
  it('does not dispatch a pending note after its view is removed', async () => {
    const id = await createPendingNote();
    const { unmount } = renderHook(() => useEnhancedRecordings(id), { wrapper });
    unmount();
    await act(async () => {
      releaseCreate();
    });
    expect(listEnhancedRecordingIds).not.toHaveBeenCalled();
  });
  it('preserves a server access denial and permits an explicit later retry', async () => {
    const denial = new ApiError('FORBIDDEN', 'No access', 403);
    vi.mocked(listEnhancedRecordingIds).mockRejectedValueOnce(denial);
    const { result } = renderHook(() => useEnhancedRecordings('nt_inaccessible'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBe(denial);
    expect(result.current.data).toBeUndefined();
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
  it('keeps disabled queries idle', async () => {
    const gate = vi.spyOn(store, 'whenNoteCreateAcked');
    renderHook(() => useEnhancedRecordings('nt_existing', { enabled: false }), { wrapper });
    expect(gate).not.toHaveBeenCalled();
    expect(listEnhancedRecordingIds).not.toHaveBeenCalled();
  });
});
