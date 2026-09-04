// @vitest-environment jsdom
/**
 * Feature-flag resolution: the platform resolver on
 * DesktopCapabilityPort.featureFlags answers synchronously and never fires the
 * org query; the cloud path reads the active org's `features` over
 * CLOUD_FEATURE_DEFAULTS. useEnsureActiveOrg is a no-op without 'organization'.
 */
import * as React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRaw: vi.fn(),
  switchOrg: vi.fn(),
  featureFlags: null as Readonly<Record<string, boolean>> | null,
  activeOrgId: null as string | null,
}));
vi.mock('../client', () => ({
  ME_PREFIX: '/apps/v1/me',
  apiClient: { getRaw: mocks.getRaw },
}));
vi.mock('../../ports-context', () => ({
  usePorts: () => ({
    auth: { switchOrg: mocks.switchOrg },
    desktopCapabilities: { featureFlags: mocks.featureFlags },
  }),
  useActiveOrgId: () => mocks.activeOrgId,
}));

const { useEnsureActiveOrg, useFeatureFlag } = await import('./organizations');

const org = (orgId: string, features: Record<string, boolean>) => ({
  orgUserId: `ou_${orgId}`,
  orgId,
  name: orgId,
  slug: orgId,
  role: 'member',
  allowPublicSharing: false,
  features,
  memberCount: 1,
});

function render<T>(hook: () => T) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(hook, { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.featureFlags = null;
  mocks.activeOrgId = null;
  mocks.getRaw.mockResolvedValue({ results: [] });
});

describe('useFeatureFlag', () => {
  it('answers from the platform table synchronously and skips the org query', () => {
    mocks.featureFlags = { autoPauseOnSilence: true, organization: false };
    const { result } = render(() => ({
      on: useFeatureFlag('autoPauseOnSilence'),
      off: useFeatureFlag('organization'),
      unknown: useFeatureFlag('billing'),
    }));
    expect(result.current.on).toEqual({ enabled: true, isResolved: true });
    expect(result.current.off).toEqual({ enabled: false, isResolved: true });
    expect(result.current.unknown).toEqual({ enabled: false, isResolved: true });
    expect(mocks.getRaw).not.toHaveBeenCalled();
  });

  it('cloud: applies CLOUD_FEATURE_DEFAULTS for keys the server does not emit', async () => {
    mocks.activeOrgId = 'org_a';
    mocks.getRaw.mockResolvedValue({ results: [org('org_a', { integrations: true })] });
    const { result } = render(() => ({
      billing: useFeatureFlag('billing'),
      integrations: useFeatureFlag('integrations'),
      unknown: useFeatureFlag('nope'),
    }));
    expect(result.current.billing.isResolved).toBe(false);
    await waitFor(() => expect(result.current.billing.isResolved).toBe(true));
    expect(result.current.billing.enabled).toBe(true);
    expect(result.current.integrations.enabled).toBe(true);
    expect(result.current.unknown.enabled).toBe(false);
    expect(mocks.getRaw).toHaveBeenCalledWith('/apps/v1/me/organizations', undefined, {
      activeOrgId: null,
    });
  });

  it('cloud: the server value wins over the default', async () => {
    mocks.activeOrgId = 'org_a';
    mocks.getRaw.mockResolvedValue({ results: [org('org_a', { billing: false })] });
    const { result } = render(() => useFeatureFlag('billing'));
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.enabled).toBe(false);
  });
});

describe('useEnsureActiveOrg', () => {
  it('switches to the first org when the active pick is invalid', async () => {
    mocks.activeOrgId = 'org_gone';
    mocks.getRaw.mockResolvedValue({ results: [org('org_a', {})] });
    const { result } = render(() => useEnsureActiveOrg());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.switchOrg).toHaveBeenCalledWith('org_a');
  });

  it("does not switch when the 'organization' flag is off", async () => {
    mocks.featureFlags = { organization: false };
    mocks.activeOrgId = 'org_gone';
    mocks.getRaw.mockResolvedValue({ results: [org('org_a', {})] });
    const { result } = render(() => useEnsureActiveOrg());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.switchOrg).not.toHaveBeenCalled();
  });
});
