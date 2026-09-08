// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const context = vi.hoisted(() => ({
  accountId: 'account_a' as string | null,
  sessionKey: 'session_a' as string | null,
  orgId: null as string | null,
  platform: 'web',
  analytics: { capture: vi.fn(), capturePageview: vi.fn() },
  auth: { getTokenForSession: vi.fn(async () => 'fixture-token') },
}));
vi.mock('../ports-context', () => ({
  useActiveAccountId: () => context.accountId,
  useActiveSessionKey: () => context.sessionKey,
  useActiveOrgId: () => context.orgId,
  useEnv: () => ({ platform: context.platform }),
  usePorts: () => ({ auth: context.auth, analytics: context.analytics }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../runtime', () => ({ getSyncPersistenceFactory: () => null }));
vi.mock('./purge', () => ({ purgeAccountPartitions: vi.fn(), registerPartitionDatabase: vi.fn() }));
vi.mock('./api', () => ({
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
import * as api from './api';
import { SyncStoreProvider, useSyncStore } from './provider';
const mocked = vi.mocked(api);
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SyncStoreProvider>{children}</SyncStoreProvider>
);
beforeEach(() => {
  vi.clearAllMocks();
  context.orgId = null;
  context.accountId = 'account_a';
  context.sessionKey = 'session_a';
  context.platform = 'web';
});
afterEach(cleanup);

it('withholds a web store until the workspace is selected', async () => {
  const { result, rerender } = renderHook(useSyncStore, { wrapper });
  await act(async () => {});
  expect(result.current).toBeNull();
  expect(mocked.restList).not.toHaveBeenCalled();
  context.orgId = 'org_a';
  rerender();
  await waitFor(() => expect(result.current?.partition.orgId).toBe('org_a'));
});

it('keeps a queued create in the selected workspace across an older pull and delayed acknowledgement', async () => {
  let acknowledge!: (row: unknown) => void;
  let submitted: Record<string, unknown> = {};
  mocked.restCreate.mockImplementation(async (_route, input) => {
    submitted = input as Record<string, unknown>;
    return new Promise(resolve => {
      acknowledge = resolve;
    });
  });
  let noteId = '';
  const { result, rerender } = renderHook(
    () => {
      const store = useSyncStore();
      React.useEffect(() => {
        if (store && !noteId) noteId = store.createNote({ title: 'Created at startup' });
      }, [store]);
      return store;
    },
    { wrapper }
  );
  await act(async () => {});
  expect(mocked.restCreate).not.toHaveBeenCalled();
  context.orgId = 'org_a';
  rerender();
  await waitFor(() => expect(mocked.restCreate).toHaveBeenCalledTimes(1));
  expect(mocked.restCreate.mock.calls[0]?.[2]).toEqual({
    authToken: 'fixture-token',
    activeOrgId: 'org_a',
  });
  await act(async () => {
    await result.current!.refreshAll();
  });
  expect(result.current!.notes$[noteId]!.peek()).toBeDefined();
  await act(async () => {
    acknowledge({ ...submitted, createdAt: '2030-01-01T00:00:00Z' });
  });
  await waitFor(() => expect(result.current!.notes$[noteId]!.createdAt.peek()).toBeTruthy());
  expect(result.current!.notes$[noteId]!.title.peek()).toBe('Created at startup');
});

it.each(['orgId', 'sessionKey', 'accountId'] as const)(
  'hides the prior store in the first %s transition commit',
  async key => {
    context.orgId = 'org_a';
    const commits: Array<ReturnType<typeof useSyncStore>> = [];
    const { result, rerender } = renderHook(
      () => {
        const store = useSyncStore();
        React.useLayoutEffect(() => {
          commits.push(store);
        });
        return store;
      },
      { wrapper }
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    const oldStore = result.current;
    commits.length = 0;
    context[key] = 'different_identity';
    rerender();
    expect(commits[0]).toBeNull();
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).not.toBe(oldStore);
  }
);

it('preserves desktop local-workspace startup without an explicit organization', async () => {
  context.platform = 'desktop';
  const { result } = renderHook(useSyncStore, { wrapper });
  await waitFor(() => expect(result.current).not.toBeNull());
  expect(result.current?.partition.orgId).toBe('');
  expect(context.auth.getTokenForSession).not.toHaveBeenCalled();
});


it('reports a stalled collection without publishing early or losing the eventual store', async () => {
  context.orgId = 'org_a';
  let release!: (rows: never[]) => void;
  mocked.restNoteTagList.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const { result } = renderHook(useSyncStore, { wrapper });
  await act(async () => {});
  expect(result.current).toBeNull();
  expect(context.analytics.capture).toHaveBeenCalledWith('loading_timing', expect.objectContaining({
    kind: 'sync_bootstrap', status: 'started',
  }));
  await act(async () => release([]));
  await waitFor(() => expect(result.current).not.toBeNull());
  expect(context.analytics.capture).toHaveBeenCalledWith('loading_timing', expect.objectContaining({
    status: 'published', notes_loaded_ms: expect.any(Number), folders_loaded_ms: expect.any(Number),
    tags_loaded_ms: expect.any(Number), note_tags_loaded_ms: expect.any(Number),
  }));
});
