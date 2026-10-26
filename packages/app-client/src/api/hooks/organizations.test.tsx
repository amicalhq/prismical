// @vitest-environment jsdom
/**
 * Feature-flag resolution: the platform resolver on
 * DesktopCapabilityPort.featureFlags answers synchronously and never fires the
 * org query; the cloud path reads the active org's `features` over
 * CLOUD_FEATURE_DEFAULTS. useEnsureActiveOrg is a no-op without 'organization'.
 */
import * as React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRaw: vi.fn(),
  postRaw: vi.fn(),
  switchOrg: vi.fn(),
  featureFlags: null as Readonly<Record<string, boolean>> | null,
  activeOrgId: null as string | null,
}));
vi.mock('../client', () => ({
  ME_PREFIX: '/apps/v1/me',
  apiClient: { getRaw: mocks.getRaw, postRaw: mocks.postRaw },
}));
vi.mock('../../ports-context', () => ({
  usePorts: () => ({
    auth: { switchOrg: mocks.switchOrg },
    desktopCapabilities: { featureFlags: mocks.featureFlags },
  }),
  useActiveOrgId: () => mocks.activeOrgId,
}));

const { useEnsureActiveOrg, useFeatureFlag, useAcceptInvitation } = await import('./organizations');

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
  vi.resetAllMocks();
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
  it('resolves a required workspace even when the workspace switcher feature is off', async () => {
    mocks.featureFlags = { organization: false };
    mocks.getRaw.mockResolvedValue({ results: [org('org_a', {})] });
    const { result } = render(() => useEnsureActiveOrg({ required: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.switchOrg).toHaveBeenCalledWith('org_a');
  });

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('useAcceptInvitation', () => {
  it('waits for memberships before switching, so the workspace guard retains the joined workspace', async () => {
    const personal = org('personal', {});
    const team = org('team', {});
    const refresh = deferred<{ results: ReturnType<typeof org>[] }>();
    mocks.activeOrgId = personal.orgId;
    mocks.getRaw.mockResolvedValueOnce({ results: [personal] }).mockReturnValue(refresh.promise);
    mocks.postRaw.mockResolvedValue({ orgId: team.orgId, role: 'member' });
    mocks.switchOrg.mockImplementation((id: string) => { mocks.activeOrgId = id; });
    const { result, rerender } = render(() => ({
      organizations: useEnsureActiveOrg({ required: true }),
      accept: useAcceptInvitation(),
    }));
    await waitFor(() => expect(result.current.organizations.isSuccess).toBe(true));
    act(() => result.current.accept.mutate('invite'));
    await waitFor(() => expect(mocks.getRaw).toHaveBeenCalledTimes(2));
    rerender();
    expect(mocks.switchOrg).not.toHaveBeenCalled();
    expect(result.current.accept.isPending).toBe(true);
    await act(async () => refresh.resolve({ results: [personal, team] }));
    await waitFor(() => expect(result.current.accept.isSuccess).toBe(true));
    rerender();
    expect(mocks.switchOrg.mock.calls).toEqual([[team.orgId]]);
    expect(mocks.activeOrgId).toBe(team.orgId);
  });

  it('loads memberships even without an organization-list observer', async () => {
    mocks.postRaw.mockResolvedValue({ orgId: 'team', role: 'member' });
    mocks.getRaw.mockResolvedValue({ results: [org('team', {})] });
    const { result } = render(() => useAcceptInvitation());
    await act(async () => { await result.current.mutateAsync('invite'); });
    expect(mocks.switchOrg).toHaveBeenCalledExactlyOnceWith('team');
  });

  it('does not switch if the refreshed list omits the joined workspace', async () => {
    mocks.postRaw.mockResolvedValue({ orgId: 'team', role: 'member' });
    mocks.getRaw.mockResolvedValue({ results: [org('personal', {})] });
    const { result } = render(() => useAcceptInvitation());
    act(() => result.current.mutate('invite'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mocks.switchOrg).not.toHaveBeenCalled();
  });

  it('recovers on retry when acceptance succeeded but the first membership refresh failed', async () => {
    mocks.postRaw.mockResolvedValueOnce({ orgId: 'team', role: 'member' })
      .mockRejectedValue(new Error('Already accepted'));
    mocks.getRaw.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({
      id: 'invite', email: 'teammate@example.com', role: 'member', status: 'accepted',
      expiresAt: '2030-01-01T00:00:00Z', organizationId: 'team', organizationName: 'Team',
      inviterName: 'Owner', canAccept: false, reason: 'already-accepted',
    }).mockResolvedValue({ results: [org('team', {})] });
    const { result } = render(() => useAcceptInvitation());
    act(() => result.current.mutate('invite'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mocks.switchOrg).not.toHaveBeenCalled();
    await act(async () => { await result.current.mutateAsync('invite'); });
    expect(mocks.switchOrg).toHaveBeenCalledExactlyOnceWith('team');
  });

  it.each(['wrong-account', 'canceled', 'expired'])('does not recover a %s invitation', async (reason) => {
    mocks.postRaw.mockRejectedValue(new Error('Cannot accept'));
    mocks.getRaw.mockResolvedValue({
      id: 'invite', email: 'teammate@example.com', role: 'member', status: 'accepted',
      expiresAt: '2030-01-01T00:00:00Z', organizationId: 'team', organizationName: 'Team',
      inviterName: 'Owner', canAccept: false, reason,
    });
    const { result } = render(() => useAcceptInvitation());
    act(() => result.current.mutate('invite'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mocks.switchOrg).not.toHaveBeenCalled();
  });

  it('does not switch or report success when the membership refresh fails', async () => {
    mocks.activeOrgId = 'personal';
    mocks.postRaw.mockResolvedValue({ orgId: 'team', role: 'member' });
    mocks.getRaw.mockRejectedValue(new Error('Offline'));
    const { result } = render(() => useAcceptInvitation());
    act(() => result.current.mutate('invite'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mocks.switchOrg).not.toHaveBeenCalled();
    expect(mocks.activeOrgId).toBe('personal');
  });
});
