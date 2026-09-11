// @vitest-environment jsdom
/**
 * The client half of the Name-note feature gate. Core already withholds the row, so this only
 * has to hold for a client reading a LOCALLY CACHED list — but that cache is exactly what would
 * otherwise resurface the skill in the dock, Ask, and the skills library.
 */
import * as React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  featureFlags: null as Readonly<Record<string, boolean>> | null,
}));
vi.mock('../client', () => ({
  ME_PREFIX: '/apps/v1/me',
  apiClient: { list: mocks.list },
}));
vi.mock('./organizations', () => ({
  useFeatureFlag: (key: string) => ({
    enabled: mocks.featureFlags?.[key] ?? false,
    isResolved: true,
  }),
}));

const { useSkillsList, skillsKey } = await import('./skills');

const skill = (id: string) => ({
  id,
  name: id,
  description: '',
  body: '',
  config: {},
  system: true,
  enabled: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

function render<T>(hook: () => T) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { ...renderHook(hook, { wrapper }), queryClient: qc };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.featureFlags = {};
  mocks.list.mockResolvedValue([skill('skl_cleanup'), skill('skl_name_note')]);
});

describe('useSkillsList', () => {
  it('reapplies flag changes without refetching or losing the cached skill', async () => {
    const { result, rerender, queryClient } = render(() => useSkillsList());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const cached = queryClient.getQueryData(skillsKey);
    expect(cached).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'skl_name_note' })]));
    expect(result.current.data?.map(s => s.id)).toEqual(['skl_cleanup']);

    mocks.featureFlags = { nameNoteSkill: true };
    rerender();
    await waitFor(() =>
      expect(result.current.data?.map(s => s.id)).toEqual(['skl_cleanup', 'skl_name_note'])
    );

    mocks.featureFlags = { nameNoteSkill: false };
    rerender();
    await waitFor(() => expect(result.current.data?.map(s => s.id)).toEqual(['skl_cleanup']));
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(skillsKey)).toBe(cached);
  });

  it('drops the gated Name-note skill when the flag is off', async () => {
    const { result } = render(() => useSkillsList());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map(s => s.id)).toEqual(['skl_cleanup']);
  });

  it('keeps it for an account inside the rollout', async () => {
    mocks.featureFlags = { nameNoteSkill: true };
    const { result } = render(() => useSkillsList());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map(s => s.id)).toEqual(['skl_cleanup', 'skl_name_note']);
  });
});
