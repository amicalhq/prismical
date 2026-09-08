// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { INERT_UPDATE_STATE, type UpdateStateView } from '@prismical/app-contracts';
import { SidebarProvider } from '../ui/sidebar';
import { SidebarUpdate } from './sidebar-update';

const caps = vi.hoisted(() => ({
  has: vi.fn(),
  getUpdateState: vi.fn(),
  onUpdateState: vi.fn(),
}));
vi.mock('@prismical/app-client', () => ({
  useDesktopCapabilities: () => caps,
  usePorts: () => ({ navigation: { Link: 'a' } }),
}));
vi.mock('../hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const ready: UpdateStateView = {
  status: 'downloaded', staged: true, stagedVersion: '1.2.3', prompt: null,
};
const link = () => screen.queryByRole('link');
const renderUpdate = () => render(<SidebarProvider><SidebarUpdate /></SidebarProvider>);

beforeEach(() => {
  caps.has.mockReturnValue(true);
  caps.getUpdateState.mockResolvedValue(INERT_UPDATE_STATE);
  caps.onUpdateState.mockReturnValue(vi.fn());
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it('restores a downloaded update after reload and links to About', async () => {
  caps.getUpdateState.mockResolvedValue(ready);
  const view = renderUpdate();
  expect((await screen.findByRole('link')).getAttribute('href')).toBe('/settings/about');
  expect(link()?.textContent).toBe('settings.about.updates.sidebarCta');
  view.unmount();
  expect(caps.onUpdateState.mock.results[0]!.value).toHaveBeenCalledOnce();
});

it('tracks readiness without letting an older snapshot or background check hide it', async () => {
  let resolveSnapshot!: (view: UpdateStateView) => void;
  caps.getUpdateState.mockReturnValue(new Promise<UpdateStateView>(resolve => {
    resolveSnapshot = resolve;
  }));
  renderUpdate();
  const publish = (state: UpdateStateView) => act(() => caps.onUpdateState.mock.calls[0]![0](state));
  expect(link()).toBeNull();
  publish({ ...INERT_UPDATE_STATE, status: 'available' });
  expect(link()).toBeNull();
  publish(ready);
  await act(async () => resolveSnapshot(INERT_UPDATE_STATE));
  expect(link()).not.toBeNull();
  publish({ ...ready, status: 'checking' });
  expect(link()).not.toBeNull();
  publish(INERT_UPDATE_STATE);
  expect(link()).toBeNull();
});

it('does not subscribe or show the action on platforms without updates', () => {
  caps.has.mockReturnValue(false);
  renderUpdate();
  expect(link()).toBeNull();
  expect(caps.getUpdateState).not.toHaveBeenCalled();
  expect(caps.onUpdateState).not.toHaveBeenCalled();
});
