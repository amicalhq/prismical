// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cta } from '@prismical/app-client';

const mocks = vi.hoisted(() => ({
  data: null as Cta | null,
  capture: vi.fn(),
  post: vi.fn(),
  refetch: vi.fn(),
  external: vi.fn(),
  user: 'user-a',
  sessionKey: undefined as string | undefined,
  org: 'org',
  token: 'pinned-token' as string | null,
  transport: null as object | null,
}));
const ports = {
  analytics: { capture: mocks.capture },
  env: { getEnv: () => ({ platform: 'web' }) },
  external: { openExternalUrl: mocks.external },
  auth: { getSession: () => ({
    state: 'signed-in', activeSub: mocks.user, activeSessionKey: mocks.sessionKey ?? mocks.user,
    accounts: [{ sub: mocks.user, sessionKey: mocks.sessionKey ?? mocks.user, activeOrgId: mocks.org }],
  }) },
};
vi.mock('@prismical/app-client', () => ({
  useCta: () => ({ data: mocks.data, refetch: mocks.refetch }),
  useActiveAccountId: () => mocks.user,
  useActiveSessionKey: () => mocks.sessionKey ?? mocks.user,
  useActiveOrgId: () => mocks.org,
  usePorts: () => ports,
  getAuthToken: () => mocks.token,
  getClientTransport: () => mocks.transport,
  activeOrgIdOf: () => mocks.org,
  apiClient: { postRaw: mocks.post },
  ME_PREFIX: '/apps/v1/me',
  EVENTS: {
    CTA_SHOWN: 'cta_shown',
    CTA_OPENED: 'cta_opened',
    CTA_CLICKED: 'cta_clicked',
    CTA_DISMISSED: 'cta_dismissed',
  },
}));
vi.mock('../ui/sidebar', () => ({
  useSidebar: () => ({
    isMobile: false,
    openMobile: false,
    state: 'expanded',
    setOpenMobile: vi.fn(),
  }),
}));
import { CtaCard, CtaProvider, CtaSidebarButton, useCtaRecordingGuard, ctaColors } from './cta';
const campaign = (): Cta => ({
  id: 'campaign',
  campaignKey: 'example',
  assignmentId: 'assignment',
  dismissed: false,
  expiresAt: null,
  content: {
    title: 'An update',
    body: 'Details',
    icon: 'gift',
    color: null,
    imageUrl: null,
    delaySeconds: 5,
    card: true,
    sidebar: true,
    sidebarLabel: 'News',
    dismissLabel: 'Dismiss',
    sidebarAction: 'open_card',
    action: { type: 'open_url', label: 'Learn more', url: 'https://example.com' },
  },
});
function Guard({ busy }: { busy: boolean }) {
  useCtaRecordingGuard(busy);
  return null;
}
function App({ busy = false }: { busy?: boolean }) {
  return (
    <CtaProvider>
      <Guard busy={busy} />
      <CtaSidebarButton />
      <button>Work</button>
    </CtaProvider>
  );
}
const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};
beforeEach(() => {
  vi.useFakeTimers();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  mocks.user = 'user-a';
  mocks.sessionKey = undefined;
  mocks.org = 'org';
  mocks.token = 'pinned-token';
  mocks.transport = null;
  mocks.data = campaign();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  mocks.post.mockReset().mockResolvedValue({ dismissed: true });
  mocks.refetch.mockReset().mockImplementation(async () => ({ isSuccess: true, data: mocks.data }));
  mocks.capture.mockReset();
  mocks.external.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CTA delivery', () => {
  it('waits five seconds, leaves focus alone and records one impression per visible transition', async () => {
    const view = render(<App />);
    screen.getByText('Work').focus();
    await advance(4999);
    expect(screen.queryByTestId('cta-card')).toBeNull();
    await advance(1);
    expect(screen.getByTestId('cta-card')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByText('Work'));
    view.rerender(<App />);
    await advance(2000);
    expect(
      mocks.capture.mock.calls.filter(
        ([event, props]) => event === 'cta_shown' && props.placement === 'card'
      )
    ).toHaveLength(1);
    fireEvent.click(screen.getByText('Learn more'));
    expect(mocks.external).toHaveBeenCalledWith('https://example.com');
    expect(mocks.capture).toHaveBeenCalledWith(
      'cta_clicked',
      expect.objectContaining({ campaign_key: 'example', placement: 'card' })
    );
  });
  it('defers and hides during recording without writing a dismissal, then restarts the delay', async () => {
    const view = render(<App busy />);
    await advance(6000);
    expect(screen.queryByTestId('cta-card')).toBeNull();
    view.rerender(<App />);
    await advance(5000);
    expect(screen.getByTestId('cta-card')).toBeTruthy();
    view.rerender(<App busy />);
    expect(screen.queryByTestId('cta-card')).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
    view.rerender(<App />);
    await advance(4999);
    expect(screen.queryByTestId('cta-card')).toBeNull();
    await advance(1);
    expect(screen.getByTestId('cta-card')).toBeTruthy();
  });
  it('honors server dismissal, retains the sidebar and accepts a reset assignment', async () => {
    mocks.data = { ...campaign(), dismissed: true };
    const view = render(<App />);
    await advance(6000);
    expect(screen.queryByTestId('cta-card')).toBeNull();
    fireEvent.click(screen.getByText('News'));
    await advance(0);
    expect(screen.getByTestId('cta-card')).toBeTruthy();
    mocks.data = { ...campaign(), assignmentId: 'reset' };
    view.rerender(<App />);
    await advance(4999);
    expect(screen.queryByTestId('cta-card')).toBeNull();
    await advance(1);
    expect(screen.getByTestId('cta-card')).toBeTruthy();
  });
  it('restarts the delay after interrupting a manually reopened card', async () => {
    mocks.data = { ...campaign(), dismissed: true };
    const view = render(<App />);
    fireEvent.click(screen.getByText('News'));
    await advance(0);
    expect(screen.getByTestId('cta-card')).toBeTruthy();
    view.rerender(<App busy />);
    expect(screen.queryByTestId('cta-card')).toBeNull();
    view.rerender(<App />);
    await advance(4999);
    expect(screen.queryByTestId('cta-card')).toBeNull();
    await advance(1);
    expect(screen.getByTestId('cta-card')).toBeTruthy();
  });

  it('keeps a failed dismissal hidden and retries with the original user credential', async () => {
    mocks.post.mockRejectedValueOnce(new Error('offline'));
    render(<App />);
    await advance(5000);
    fireEvent.click(screen.getByLabelText('Dismiss'));
    await advance(0);
    expect(localStorage.getItem('cta-dismissal:user-a')).toBe('assignment');
    await advance(10000);
    expect(screen.queryByTestId('cta-card')).toBeNull();
    mocks.data = { ...campaign(), dismissed: true };
    await advance(5000);
    expect(mocks.post).toHaveBeenCalledWith('/apps/v1/me/cta/assignment/dismiss', undefined, {
      authToken: 'pinned-token',
    });
    expect(localStorage.getItem('cta-dismissal:user-a')).toBeNull();
  });
  it('dismisses through desktop transport without a renderer token', async () => {
    mocks.token = null;
    mocks.transport = {};
    render(<App />);
    await advance(5000);
    mocks.data = { ...campaign(), dismissed: true };
    fireEvent.click(screen.getByLabelText('Dismiss'));
    await advance(0);
    expect(mocks.post).toHaveBeenCalledWith('/apps/v1/me/cta/assignment/dismiss', undefined, undefined);
    expect(localStorage.getItem('cta-dismissal:user-a')).toBeNull();
  });
  it('does not send a web dismissal without its credential', async () => {
    mocks.token = null;
    render(<App />);
    await advance(5000);
    fireEvent.click(screen.getByLabelText('Dismiss'));
    await advance(20000);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(localStorage.getItem('cta-dismissal:user-a')).toBe('assignment');
  });
  it.each(['session', 'organization'] as const)('does not restamp a desktop dismissal retry after a %s switch', async scope => {
    mocks.token = null;
    mocks.transport = {};
    mocks.post.mockRejectedValueOnce(new Error('offline'));
    render(<App />);
    await advance(5000);
    fireEvent.click(screen.getByLabelText('Dismiss'));
    await advance(0);
    expect(mocks.post).toHaveBeenCalledOnce();
    // Authoritative auth has changed before React has remounted the CTA owner.
    if (scope === 'session') mocks.sessionKey = 'replacement-session';
    else mocks.org = 'replacement-org';
    fireEvent(window, new Event('online'));
    await advance(15000);
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(localStorage.getItem('cta-dismissal:user-a')).toBe('assignment');
  });
  it('does not release pending dismissal after a failed authoritative refresh', async () => {
    mocks.refetch.mockResolvedValue({ isSuccess: false, data: mocks.data });
    render(<App />);
    await advance(5000);
    fireEvent.click(screen.getByLabelText('Dismiss'));
    await advance(20000);
    expect(screen.queryByTestId('cta-card')).toBeNull();
    expect(localStorage.getItem('cta-dismissal:user-a')).toBe('assignment');
  });
  it('does not clear the original dismissal when a desktop response arrives after an owner switch', async () => {
    mocks.token = null;
    mocks.transport = {};
    let resolvePost!: () => void;
    mocks.post.mockReturnValueOnce(new Promise<void>(resolve => { resolvePost = resolve; }));
    render(<App />);
    await advance(5000);
    fireEvent.click(screen.getByLabelText('Dismiss'));
    await advance(0);
    mocks.org = 'replacement-org';
    await act(async () => { resolvePost(); });
    expect(mocks.refetch).not.toHaveBeenCalled();
    expect(localStorage.getItem('cta-dismissal:user-a')).toBe('assignment');
  });
  it('hides immediately for another account and removes expired cards', async () => {
    const view = render(<App />);
    await advance(5000);
    expect(screen.getByTestId('cta-card')).toBeTruthy();
    mocks.user = 'user-b';
    mocks.data = null;
    view.rerender(<App />);
    expect(screen.queryByTestId('cta-card')).toBeNull();
    mocks.data = { ...campaign(), expiresAt: new Date(Date.now() + 6000).toISOString() };
    view.rerender(<App />);
    await advance(5000);
    expect(screen.getByTestId('cta-card')).toBeTruthy();
    await advance(1000);
    expect(screen.queryByTestId('cta-card')).toBeNull();
  });
  it('renders independent colors and preserves the legacy accent fallback', () => {
    const cta = campaign();
    cta.content = {
      ...cta.content,
      color: '#ffffff',
      headerColor: '#123456',
      iconColor: '#abcdef',
      buttonColor: '#000000',
    };
    const view = render(<CtaCard cta={cta} onDismiss={() => {}} onAction={() => {}} />);
    expect(screen.getByRole('heading').style.color).toBe('rgb(18, 52, 86)');
    const action = screen.getByRole('button', { name: cta.content.action.label });
    expect(action.style.backgroundColor).toBe('rgb(0, 0, 0)');
    expect(action.style.color).toBe('rgb(255, 255, 255)');
    expect(view.container.querySelector('div[style]')?.getAttribute('style')).toContain(
      'rgb(171, 205, 239)'
    );
    view.rerender(
      <CtaCard
        cta={{ ...cta, content: { ...cta.content, buttonColor: null } }}
        onDismiss={() => {}}
        onAction={() => {}}
      />
    );
    expect(action.style.backgroundColor).toBe('rgb(255, 255, 255)');
  });
  it('renders gradient text and independent gradient fills, then restores solid colors', () => {
    const cta = campaign();
    cta.content = {
      ...cta.content,
      headerGradient: 'indigo',
      iconGradient: 'purple',
      buttonGradient: 'pink',
      buttonColor: '#123456',
    };
    const view = render(<CtaCard cta={cta} onDismiss={() => {}} onAction={() => {}} />);
    expect(screen.getByRole('heading').style.backgroundClip).toBe('text');
    expect(screen.getByRole('heading').style.backgroundImage).toContain('linear-gradient');
    expect(view.container.querySelector('div[style]')?.getAttribute('style')).toContain(
      'rgb(167, 139, 250)'
    );
    const action = screen.getByRole('button', { name: cta.content.action.label });
    expect(action.style.backgroundImage).toContain('rgb(244, 114, 182)');
    expect(action.style.color).toBe('rgb(0, 0, 0)');
    view.rerender(
      <CtaCard
        cta={{ ...cta, content: { ...cta.content, headerGradient: null, buttonGradient: null } }}
        onDismiss={() => {}}
        onAction={() => {}}
      />
    );
    expect(action.style.backgroundImage).toBe('');
    expect(action.style.backgroundColor).toBe('rgb(18, 52, 86)');
    expect(screen.getByRole('heading').style.backgroundClip).toBe('');
  });
  it('uses readable foregrounds for color overrides', () => {
    expect(ctaColors('#ffffff')).toEqual({ backgroundColor: '#ffffff', color: '#000000' });
    expect(ctaColors('#000000')).toEqual({ backgroundColor: '#000000', color: '#ffffff' });
    expect(ctaColors(null)).toBeUndefined();
  });
});
