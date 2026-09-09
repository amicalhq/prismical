import type { EnvDescriptor } from '@prismical/desktop-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopPorts } from '../../src/renderer/main/app/ports/desktop-ports';

const router = vi.hoisted(() => ({
  state: { location: { pathname: '/notes/note_b' } },
  history: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
}));
vi.mock('../../src/renderer/main/app/router', () => ({ router }));
vi.mock('../../src/renderer/main/app/analytics/posthog', () => ({ desktopAnalyticsPort: {} }));

const env: EnvDescriptor = {
  appMode: 'local',
  platform: 'darwin',
  appVersion: '0.0.0-test',
  noteWsUrl: 'wss://note.test',
  webAppOrigin: 'https://app.test',
  gleap: null,
  analyticsKey: null,
  analyticsHost: null,
  applicationLocale: 'en',
  systemLocale: 'en',
};

afterEach(() => {
  router.state.location.pathname = '/notes/note_b';
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('desktop recording-owner navigation', () => {
  it('retargets the floating window to the recording note without mounting the main shell', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { desktop: { float: { open } } });
    router.state.location.pathname = '/float/note_b';

    createDesktopPorts(env).appPorts.navigation.useNavigation().push('/notes/note_a');

    expect(open).toHaveBeenCalledExactlyOnceWith('note_a');
    expect(router.history.push).not.toHaveBeenCalled();
  });

  it('returns to the recording note in the main window', () => {
    createDesktopPorts(env).appPorts.navigation.useNavigation().push('/notes/note_a');
    expect(router.history.push).toHaveBeenCalledExactlyOnceWith('/notes/note_a');
  });
});
