// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopEnv } from '../../src/renderer/main/app/desktop-env';
import { GleapProvider, useGleapSupportAction } from '../../src/renderer/main/app/support/gleap';

const mock = vi.hoisted(() => ({
  env: {} as DesktopEnv,
  session: { activeSub: undefined as string | undefined, accounts: [] as { sub: string; name: string; email: string }[] },
  ready: () => {},
  sdk: {
    setCSPNonce: vi.fn(), setDisablePageTracking: vi.fn(), disableConsoleLogOverwrite: vi.fn(),
    setMaxNetworkRequests: vi.fn(), setNetworkLogsBlacklist: vi.fn(), setReplayOptions: vi.fn(),
    setLanguage: vi.fn(), setAppVersionCode: vi.fn(), attachCustomData: vi.fn(), setUrlHandler: vi.fn(),
    showFeedbackButton: vi.fn(), on: vi.fn(), initialize: vi.fn(), destroy: vi.fn(),
    getIdentity: vi.fn(), identify: vi.fn(), clearIdentity: vi.fn(), close: vi.fn(), open: vi.fn(),
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@prismical/app-client', () => ({ useSessionView: () => mock.session }));
vi.mock('../../src/renderer/main/app/desktop-env', () => ({ useDesktopEnv: () => mock.env }));
vi.mock('gleap', () => ({ default: mock.sdk }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  mock.ready = () => {};
  mock.env = {
    gleap: { key: 'test-key', cspNonce: 'test-nonce' }, appMode: 'cloud', appModeChosen: true,
    appVersion: '1.2.3', platform: 'darwin', applicationLocale: 'en', systemLocale: 'en',
    noteWsUrl: 'wss://note.test', webAppOrigin: 'https://app.test', analyticsKey: null, analyticsHost: null,
  };
  mock.session = { activeSub: undefined, accounts: [] };
  mock.sdk.on.mockImplementation((_event, ready) => { mock.ready = ready; });
  mock.sdk.getIdentity.mockReturnValue(undefined);
  window.location.hash = '#/home';
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
});
const SupportAction = () => useGleapSupportAction() ?? createElement('a', { href: 'mailto:support@test.invalid' }, 'Email support');
const render = (strict = false) => act(async () => {
  const app = createElement(GleapProvider, { children: createElement(SupportAction) });
  root.render(strict ? createElement(StrictMode, null, app) : app);
});
const ready = () => act(async () => mock.ready());

describe('cloud-only Gleap lifecycle', () => {
  it('does not initialize in local mode, even with a configured key', async () => {
    mock.env.appMode = 'local';
    await render();
    expect(mock.sdk.setCSPNonce).not.toHaveBeenCalled();
    expect(mock.sdk.initialize).not.toHaveBeenCalled();
  });
  it('waits for an explicit cloud choice, then initializes once under StrictMode', async () => {
    mock.env = { ...mock.env, appModeChosen: false };
    await render(true);
    expect(mock.sdk.setCSPNonce).not.toHaveBeenCalled();
    mock.env = { ...mock.env, appModeChosen: true };
    await render(true);
    expect(mock.sdk.initialize).toHaveBeenCalledExactlyOnceWith('test-key');
    expect(mock.sdk.setCSPNonce).toHaveBeenCalledWith('test-nonce');
    expect(mock.sdk.disableConsoleLogOverwrite.mock.invocationCallOrder[0]).toBeLessThan(mock.sdk.initialize.mock.invocationCallOrder[0]!);
    expect(mock.sdk.setMaxNetworkRequests).toHaveBeenCalledWith(0);
    await ready();
    expect(mock.sdk.showFeedbackButton).toHaveBeenLastCalledWith(true);
  });
  it.each(['float', 'missing key'])('stays disabled for %s', async kind => {
    if (kind === 'float') window.location.hash = '#/float/note-1';
    else mock.env.gleap = null;
    await render();
    expect(mock.sdk.initialize).not.toHaveBeenCalled();
  });
  it('uses the latest account after loading and clears identity on switch and logout', async () => {
    await render();
    expect(mock.sdk.initialize).toHaveBeenCalledExactlyOnceWith('test-key');
    mock.session = { activeSub: 'a', accounts: [{ sub: 'a', name: 'A', email: 'a@test.invalid' }] };
    await render();
    await ready();
    expect(mock.sdk.identify).toHaveBeenLastCalledWith('a', { name: 'A', email: 'a@test.invalid' });
    expect(mock.sdk.showFeedbackButton).toHaveBeenLastCalledWith(false);
    mock.sdk.getIdentity.mockReturnValue({ userId: 'a' });
    mock.session = { activeSub: 'b', accounts: [{ sub: 'b', name: 'B', email: 'b@test.invalid' }] };
    await render();
    expect(mock.sdk.close).toHaveBeenCalledTimes(2);
    expect(mock.sdk.clearIdentity).toHaveBeenCalledOnce();
    expect(mock.sdk.identify).toHaveBeenLastCalledWith('b', { name: 'B', email: 'b@test.invalid' });
    mock.sdk.getIdentity.mockReturnValue({ userId: 'b' });
    mock.session = { activeSub: undefined, accounts: [] };
    await render();
    expect(mock.sdk.clearIdentity).toHaveBeenCalledTimes(2);
    expect(mock.sdk.showFeedbackButton).toHaveBeenLastCalledWith(true);
  });
  it.each(['switch', 'logout'])('discards a pending identity before %s', async transition => {
    let resolveIdentify!: () => void;
    const pending = new Promise<void>(resolve => { resolveIdentify = resolve; });
    mock.sdk.identify.mockReturnValueOnce(pending);
    mock.session = { activeSub: 'a', accounts: [{ sub: 'a', name: 'A', email: 'a@test.invalid' }] };
    await render();
    await ready();
    expect(mock.sdk.identify).toHaveBeenCalledOnce();
    expect(document.querySelector('a')?.textContent).toBe('Email support');
    expect(document.querySelector('button')).toBeNull();

    mock.session = transition === 'switch'
      ? { activeSub: 'b', accounts: [{ sub: 'b', name: 'B', email: 'b@test.invalid' }] }
      : { activeSub: undefined, accounts: [] };
    await render();
    expect(mock.sdk.identify).toHaveBeenCalledOnce();
    expect(mock.sdk.showFeedbackButton).toHaveBeenLastCalledWith(false);

    await act(async () => {
      mock.sdk.getIdentity.mockReturnValue({ userId: 'a' });
      mock.sdk.clearIdentity.mockImplementation(() => { mock.sdk.getIdentity.mockReturnValue(undefined); });
      resolveIdentify();
    });
    expect(mock.sdk.clearIdentity).toHaveBeenCalledOnce();
    const supportButton = document.querySelector('button');
    expect(supportButton?.getAttribute('aria-label')).toBe('navigation.secondary.sendFeedback');
    await act(async () => supportButton!.click());
    expect(mock.sdk.open).toHaveBeenCalledOnce();
    if (transition === 'switch') {
      expect(mock.sdk.identify).toHaveBeenLastCalledWith('b', { name: 'B', email: 'b@test.invalid' });
      expect(mock.sdk.clearIdentity.mock.invocationCallOrder[0]).toBeLessThan(mock.sdk.identify.mock.invocationCallOrder[1]!);
    } else {
      expect(mock.sdk.identify).toHaveBeenCalledOnce();
      expect(mock.sdk.showFeedbackButton).toHaveBeenLastCalledWith(true);
    }
  });
  it('handles failed identification and allows a later account to connect', async () => {
    mock.sdk.identify.mockRejectedValueOnce(new Error('offline'));
    mock.session = { activeSub: 'a', accounts: [{ sub: 'a', name: 'A', email: 'a@test.invalid' }] };
    await render();
    await ready();
    expect(mock.sdk.clearIdentity).toHaveBeenCalledOnce();
    expect(mock.sdk.showFeedbackButton).toHaveBeenLastCalledWith(false);
    mock.session = { activeSub: 'b', accounts: [{ sub: 'b', name: 'B', email: 'b@test.invalid' }] };
    await render();
    expect(mock.sdk.identify).toHaveBeenLastCalledWith('b', { name: 'B', email: 'b@test.invalid' });
  });
  it('clears a persisted identity when the app starts signed out', async () => {
    mock.sdk.getIdentity.mockReturnValue({ userId: 'old-user' });
    await render();
    await ready();
    expect(mock.sdk.clearIdentity).toHaveBeenCalledOnce();
    expect(mock.sdk.identify).not.toHaveBeenCalled();
  });
});
