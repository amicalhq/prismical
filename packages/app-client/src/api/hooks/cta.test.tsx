// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCta } from './cta';

const mock = vi.hoisted(() => ({
  flags: null as Record<string, boolean> | null,
  get: vi.fn(),
}));
vi.mock('../client', () => ({
  apiClient: { getRaw: mock.get },
  ME_PREFIX: '/apps/v1/me',
}));
vi.mock('../../ports-context', () => ({
  useActiveAccountId: () => 'user',
  useActiveOrgId: () => 'org',
  useActiveSessionKey: () => 'session',
}));

vi.mock('../../settings/use-desktop-capabilities', () => ({
  useDesktopCapabilities: () => ({ featureFlags: mock.flags }),
}));

beforeEach(() => {
  mock.flags = null;
  mock.get.mockReset().mockResolvedValue({ cta: null });
});
afterEach(cleanup);

function mount() {
  const client = new QueryClient();
  return renderHook(() => useCta(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children),
  });
}

it('does not poll cloud campaigns in a local workspace, including manual refresh', async () => {
  mock.flags = {};
  const hook = mount();
  await act(async () => {
    expect((await hook.result.current.refetch()).data).toBeNull();
  });
  expect(mock.get).not.toHaveBeenCalled();
});

it('loads campaigns for a cloud workspace', async () => {
  const hook = mount();
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(mock.get).toHaveBeenCalledWith('/apps/v1/me', undefined, {
    activeOrgId: 'org', signal: expect.any(AbortSignal),
  });
});
