// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ViewerProfile } from '@prismical/api-contracts/apps/v1';
import type { MainWindowDesktopApi, TransportResponse } from '@prismical/desktop-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopAccountDetails } from '../../src/renderer/main/app/settings/account-details';

const state = vi.hoisted(() => ({
  accountId: 'user-a' as string | null,
  sessionSub: 'user-a' as string | null,
  orgId: 'org-a' as string | null,
  loadProfile: vi.fn<() => Promise<ViewerProfile>>(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@prismical/app-client', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  return {
    useActiveAccountId: () => state.accountId,
    useActiveOrgId: () => state.orgId,
    usePorts: () => ({ auth: { getSession: () => ({ activeSub: state.sessionSub }) } }),
    viewerProfileKey: ['viewer-profile'],
    useViewerProfile: () =>
      useQuery({
        queryKey: ['viewer-profile'],
        queryFn: state.loadProfile,
        staleTime: Infinity,
      }),
  };
});

const PROFILE_KEY = ['viewer-profile'];
const original: ViewerProfile = {
  id: 'user-a',
  email: 'ada@example.test',
  name: 'Ada',
  image: 'https://example.test/avatar.png',
};
const updated: ViewerProfile = { ...original, name: 'Ada Lovelace', image: null };
const request = vi.fn<MainWindowDesktopApi['transport']['request']>();
const openWebSession = vi.fn<MainWindowDesktopApi['auth']['openWebSession']>();
let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.accountId = 'user-a';
  state.sessionSub = 'user-a';
  state.orgId = 'org-a';
  state.loadProfile.mockReset().mockResolvedValue(original);
  request.mockReset().mockResolvedValue({ ok: true, status: 200, bodyJson: updated });
  openWebSession.mockReset().mockResolvedValue(undefined);
  Object.assign(window, { desktop: { transport: { request }, auth: { openWebSession } } });
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
});

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
const render = async () => {
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(DesktopAccountDetails)
      )
    )
  );
  await settle();
};
const button = (label: string) =>
  [...container.querySelectorAll('button')].find(element => element.textContent?.includes(label))!;
const alerts = () =>
  [...container.querySelectorAll('[role="alert"]')].map(element => element.textContent);
const saved = () => container.textContent?.includes('settings.account.controls.saved');

async function editName(value = 'Ada Lovelace') {
  const input = container.querySelector<HTMLInputElement>('#account-name')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(label: string) {
  await act(async () => button(label).click());
  await settle();
}

describe('desktop account details', () => {
  it('uses the actual profile form and identity-bound main transport; success updates shared profile cache', async () => {
    const pending = deferred<TransportResponse>();
    request.mockReturnValueOnce(pending.promise);
    await render();
    expect(button('common.actions.save').disabled).toBe(true);
    await editName('  Ada Lovelace  ');
    await click('settings.account.controls.removePhoto');
    await click('common.actions.save');
    expect(request).toHaveBeenCalledExactlyOnceWith({
      method: 'PATCH',
      path: '/apps/v1/me/profile',
      body: { name: 'Ada Lovelace', image: null },
      expectedAccountId: 'user-a',
    });
    expect(container.querySelector<HTMLInputElement>('#account-name')!.disabled).toBe(true);
    expect(button('common.actions.save').disabled).toBe(true);
    await act(async () => pending.resolve({ ok: true, status: 200, bodyJson: updated }));
    await settle();
    expect(queryClient.getQueryData(PROFILE_KEY)).toEqual(updated);
    expect(saved()).toBe(true);
    expect(button('common.actions.save').disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('#account-name')!.disabled).toBe(false);
  });

  it('does not overwrite the next account profile when an earlier save finishes', async () => {
    const pending = deferred<TransportResponse>();
    request.mockReturnValueOnce(pending.promise);
    await render();
    await editName();
    await click('common.actions.save');
    const next: ViewerProfile = {
      id: 'user-b',
      name: 'Grace',
      email: 'grace@example.test',
      image: null,
    };
    state.accountId = 'user-b';
    state.sessionSub = 'user-b';
    await act(async () => {
      queryClient.setQueryData(PROFILE_KEY, next);
    });
    await render();
    await act(async () => pending.resolve({ ok: true, status: 200, bodyJson: updated }));
    await settle();
    expect(queryClient.getQueryData(PROFILE_KEY)).toEqual(next);
    expect(container.querySelector<HTMLInputElement>('#account-name')!.value).toBe('Grace');
    expect(saved()).toBe(false);
  });

  it('checks the live auth identity even before an account-switch rerender', async () => {
    const pending = deferred<TransportResponse>();
    request.mockReturnValueOnce(pending.promise);
    await render();
    await editName();
    await click('common.actions.save');
    state.sessionSub = 'user-b';
    await act(async () => pending.resolve({ ok: true, status: 200, bodyJson: updated }));
    await settle();
    expect(queryClient.getQueryData(PROFILE_KEY)).toEqual(original);
    expect(saved()).toBe(false);
  });

  it('does not publish a save that completes after the account controls unmount', async () => {
    const pending = deferred<TransportResponse>();
    request.mockReturnValueOnce(pending.promise);
    await render();
    await editName();
    await click('common.actions.save');
    await act(async () => root.render(null));
    await act(async () => pending.resolve({ ok: true, status: 200, bodyJson: updated }));
    await settle();
    expect(queryClient.getQueryData(PROFILE_KEY)).toEqual(original);
    expect(container.textContent).toBe('');
  });

  it.each<TransportResponse>([
    { error: { code: 'INTERNAL' } },
    { ok: true, status: 422, bodyJson: { error: 'Invalid profile' } },
    { ok: true, status: 200, bodyJson: { id: 'user-a', name: 123 } },
  ])('shows a failed save and allows a successful retry: %j', async failure => {
    request.mockResolvedValueOnce(failure);
    await render();
    await editName();
    await click('common.actions.save');
    expect(alerts()).toContain('settings.account.controls.failed');
    expect(saved()).toBe(false);
    expect(queryClient.getQueryData(PROFILE_KEY)).toEqual(original);
    expect(button('common.actions.save').disabled).toBe(false);
    await click('common.actions.save');
    expect(request).toHaveBeenCalledTimes(2);
    expect(alerts()).toEqual([]);
    expect(saved()).toBe(true);
    expect(queryClient.getQueryData(PROFILE_KEY)).toEqual(updated);
  });

  it('shows loading, then a retry control when profile loading fails', async () => {
    const pending = deferred<ViewerProfile>();
    state.loadProfile.mockReturnValueOnce(pending.promise);
    await render();
    expect(container.querySelector('#account-name')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('common.status.loading');
    await act(async () => pending.reject(new Error('offline')));
    await settle();
    expect(alerts().join(' ')).toContain('settings.account.controls.failed');
    await click('settings.account.controls.retry');
    expect(state.loadProfile).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLInputElement>('#account-name')!.value).toBe('Ada');
    expect(alerts()).toEqual([]);
  });

  it.each(['org-a', null])(
    'hands sign-in management to main with the current organization: %s',
    async orgId => {
      state.orgId = orgId;
      const pending = deferred<void>();
      openWebSession.mockReturnValueOnce(pending.promise);
      await render();
      await click('settings.account.securityHandoff.action');
      expect(openWebSession).toHaveBeenCalledExactlyOnceWith({
        returnPath: '/settings/account',
        ...(orgId ? { activeOrgId: orgId } : {}),
      });
      expect(button('settings.account.securityHandoff.action').disabled).toBe(true);
      expect(request).not.toHaveBeenCalled();
      await act(async () => pending.resolve());
      await settle();
      expect(button('settings.account.securityHandoff.action').disabled).toBe(false);
      expect(alerts()).toEqual([]);
    }
  );

  it('shows a failed browser handoff and retries through auth rather than the REST transport', async () => {
    openWebSession.mockRejectedValueOnce(new Error('browser unavailable'));
    await render();
    await click('settings.account.securityHandoff.action');
    expect(alerts()).toContain('settings.account.controls.failed');
    expect(button('settings.account.securityHandoff.action').disabled).toBe(false);
    await click('settings.account.securityHandoff.action');
    expect(openWebSession).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalled();
    expect(alerts()).toEqual([]);
  });

  it('does not show account controls or load a profile without an active account', async () => {
    state.accountId = null;
    state.sessionSub = null;
    await render();
    expect(container.textContent).toBe('');
    expect(state.loadProfile).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(openWebSession).not.toHaveBeenCalled();
  });
});
