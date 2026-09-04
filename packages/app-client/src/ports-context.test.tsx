// @vitest-environment jsdom
import * as React from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppPorts, NavigationAdapter } from './ports-context';
import {
  PortsProvider,
  useEnv,
  useNavigation,
  useParams,
  usePathname,
  usePorts,
  useSearchParams,
  useSessionView,
  useActiveAccountId,
  useActiveOrgId,
  useActiveSessionKey,
} from './ports-context';
import type { EnvDescriptor, SessionView } from '@prismical/app-contracts';
import { DEFAULT_DEVICE_SETTINGS, INERT_UPDATE_STATE } from '@prismical/app-contracts';

const pushSpy = vi.fn();

const fakeNavigation: NavigationAdapter = {
  useNavigation: () => ({ push: pushSpy, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/notes',
  useSearchParams: () => new URLSearchParams('folder=fld_1'),
  useParams: <T,>() => ({ id: 'note_1' }) as T,
  Link: props => <a {...props} />,
};

const env: EnvDescriptor = {
  noteWsUrl: 'wss://note.test/collaboration',
  webAppOrigin: 'https://web.test',
  analyticsKey: null,
  platform: 'web',
  appVersion: null,
};

function makeAuthStore(initial: SessionView) {
  let view = initial;
  const listeners = new Set<(v: SessionView) => void>();
  return {
    set(next: SessionView) {
      view = next;
      for (const l of listeners) l(next);
    },
    port: {
      getSession: () => view,
      onSessionChanged: (listener: (v: SessionView) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      signIn: () => Promise.resolve(),
      addAccount: () => Promise.resolve(),
      signOut: () => Promise.resolve(),
      switchAccount: () => {},
      switchOrg: () => {},
      getToken: () => Promise.resolve(null),
      getTokenForSession: () => Promise.resolve(null),
    },
  };
}

function makePorts(auth: AppPorts['auth']): AppPorts {
  return {
    navigation: fakeNavigation,
    env: { getEnv: () => ({ ...env }) },
    auth,
    assets: { resolve: p => p },
    external: {
      openAuthorizationUrl: vi.fn(),
      authorizationReturnTo: (p: string) => `https://web.test${p}`,
      openExternalUrl: vi.fn(),
    },
    desktopCapabilities: {
      has: () => false,
      featureFlags: null,
      settings: {
        get: () => Promise.resolve(DEFAULT_DEVICE_SETTINGS),
        set: () => Promise.resolve(),
        subscribe: () => () => {},
      },
      checkForUpdates: () => Promise.resolve({ status: 'disabled' }),
      getUpdateState: () => Promise.resolve(INERT_UPDATE_STATE),
      onUpdateState: () => () => {},
      restartToUpdate: () => Promise.resolve(),
      dismissUpdatePrompt: () => Promise.resolve(),
      exportLogs: () => Promise.resolve(),
      openFloatingNote: () => Promise.resolve(),
      restartApp: () => Promise.resolve(),
      resetApp: () => Promise.resolve(),
      getPermissionStatus: () =>
        Promise.resolve({ microphone: 'unavailable', systemAudio: 'unavailable' }),
      requestPermission: () =>
        Promise.resolve({ microphone: 'unavailable', systemAudio: 'unavailable' }),
      openSystemSettings: () => Promise.resolve(),
      getAppleCalendarStatus: () =>
        Promise.resolve({
          permission: 'unavailable',
          state: 'disabled',
          lastRefreshedAt: null,
          error: null,
        }),
      enableAppleCalendar: () =>
        Promise.resolve({
          permission: 'unavailable',
          state: 'disabled',
          lastRefreshedAt: null,
          error: null,
        }),
      refreshAppleCalendar: () =>
        Promise.resolve({
          permission: 'unavailable',
          state: 'disabled',
          lastRefreshedAt: null,
          error: null,
        }),
      localModels: {
        getState: () => Promise.resolve({ models: [], modelsDir: '' }),
        download: () => Promise.resolve(),
        cancelDownload: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        subscribe: () => () => {},
      },
      transcriptionByok: {
        setKey: () => Promise.resolve(),
        clearKey: () => Promise.resolve(),
        hasKey: () => Promise.resolve(false),
      },
      aiProvider: {
        setKey: () => Promise.resolve(),
        clearKey: () => Promise.resolve(),
        hasKey: () => Promise.resolve(false),
        listModels: () => Promise.resolve({ models: [], error: "unsupported" }),
      },
    },
    analytics: { capture: vi.fn(), capturePageview: vi.fn() },
    recording: { uploadTranscriptionChunk: vi.fn(() => Promise.resolve([])) },
  };
}

function wrapperFor(ports: AppPorts) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <PortsProvider ports={ports}>{children}</PortsProvider>;
  };
}

describe('ports context', () => {
  it('usePorts throws without a provider', () => {
    expect(() => renderHook(() => usePorts())).toThrow(
      'usePorts must be used within a PortsProvider'
    );
  });

  it('routes the navigation hooks through the provided adapter', () => {
    const store = makeAuthStore({ state: 'signed-out', accounts: [] });
    const wrapper = wrapperFor(makePorts(store.port));
    const { result } = renderHook(
      () => ({
        nav: useNavigation(),
        pathname: usePathname(),
        search: useSearchParams(),
        params: useParams<{ id: string }>(),
      }),
      { wrapper }
    );
    result.current.nav.push('/home');
    expect(pushSpy).toHaveBeenCalledWith('/home');
    expect(result.current.pathname).toBe('/notes');
    expect(result.current.search.get('folder')).toBe('fld_1');
    expect(result.current.params.id).toBe('note_1');
  });

  it('memoizes the env descriptor per provider', () => {
    const store = makeAuthStore({ state: 'signed-out', accounts: [] });
    const wrapper = wrapperFor(makePorts(store.port));
    const { result, rerender } = renderHook(() => useEnv(), { wrapper });
    const first = result.current;
    expect(first.noteWsUrl).toBe('wss://note.test/collaboration');
    rerender();
    expect(result.current).toBe(first);
  });

  it('useSessionView tracks AuthPort session pushes', () => {
    const store = makeAuthStore({ state: 'signed-out', accounts: [] });
    const wrapper = wrapperFor(makePorts(store.port));
    const { result } = renderHook(() => useSessionView(), { wrapper });
    expect(result.current.state).toBe('signed-out');
    act(() => {
      store.set({
        state: 'signed-in',
        accounts: [{ sub: 'sub_a', email: 'a@x.dev' }],
        activeSub: 'sub_a',
      });
    });
    expect(result.current.state).toBe('signed-in');
    expect(result.current.activeSub).toBe('sub_a');
  });

  it('keeps product subject stable while the exact same-sub login slot changes', () => {
    const store = makeAuthStore({
      state: 'signed-in',
      accounts: [
        {
          sub: 'sub_target',
          sessionKey: 'slot_ordinary',
          email: 'target@x.dev',
          activeOrgId: 'org_a',
        },
        {
          sub: 'sub_target',
          sessionKey: 'slot_support',
          email: 'target@x.dev',
          activeOrgId: 'org_b',
        },
      ],
      activeSub: 'sub_target',
      activeSessionKey: 'slot_support',
    });
    const wrapper = wrapperFor(makePorts(store.port));
    const { result } = renderHook(
      () => ({
        accountId: useActiveAccountId(),
        sessionKey: useActiveSessionKey(),
        orgId: useActiveOrgId(),
      }),
      { wrapper }
    );

    expect(result.current).toEqual({
      accountId: 'sub_target',
      sessionKey: 'slot_support',
      orgId: 'org_b',
    });
    act(() => {
      store.set({
        state: 'signed-in',
        accounts: [
          {
            sub: 'sub_target',
            sessionKey: 'slot_ordinary',
            email: 'target@x.dev',
            activeOrgId: 'org_a',
          },
        ],
        activeSub: 'sub_target',
        activeSessionKey: 'slot_ordinary',
      });
    });
    expect(result.current).toEqual({
      accountId: 'sub_target',
      sessionKey: 'slot_ordinary',
      orgId: 'org_a',
    });
  });
});
