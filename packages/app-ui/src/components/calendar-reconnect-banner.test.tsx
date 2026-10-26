// @vitest-environment jsdom
import * as React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createApplicationI18nSync } from '@prismical/app-i18n';

const mocks = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  start: vi.fn(),
  params: new URLSearchParams(),
  navigation: { replace: vi.fn() },
}));
vi.mock('@prismical/app-client', () => ({
  useConnections: () => ({ data: mocks.connections }),
  useNavigation: () => mocks.navigation,
  useSearchParams: () => mocks.params,
  useCalendars: () => ({ data: [] }),
  useDisconnectCalendar: () => ({ mutate: vi.fn(), isPending: false }),
  useDisconnectEventKitIntegration: () => ({ isPending: false }),
  useEnableEventKitIntegration: () => ({ isPending: false }),
  useEventKitIntegration: () => ({ data: null }),
  useFeatureFlag: () => ({ enabled: false }),
  useDesktopCapabilities: () => ({ has: () => false }),
  useInvalidateConnections: () => vi.fn(),
  useRefreshCalendarsOnFirstSync: () => {},
  useSetCalendarEnabled: () => ({ mutate: vi.fn() }),
}));
vi.mock('../shell/app-link', () => ({
  AppLink: React.forwardRef<HTMLAnchorElement, React.ComponentProps<'a'>>(function MockLink(props, ref) {
    return <a ref={ref} {...props} />;
  }),
}));
vi.mock('../lib/use-connect-flow', () => ({
  useConnectFlow: () => ({ start: mocks.start, pending: false }),
}));
const { CalendarReconnectBanner } = await import('./calendar-reconnect-banner');
const { CalendarScreen } = await import('../screens/settings/calendar-screen');
const i18n = createApplicationI18nSync('en');
const wrap = (child: React.ReactNode) => <I18nextProvider i18n={i18n}>{child}</I18nextProvider>;
beforeEach(() => {
  mocks.start.mockClear();
  mocks.connections = [
    {
      id: 'cn_test',
      provider: 'google',
      status: 'error',
      statusReason: 'authentication_failed',
      accountEmail: 'calendar@example.com',
      lastSyncedAt: new Date().toISOString(),
    },
  ];
});
afterEach(cleanup);

it('links a single failed account to settings instead of launching OAuth from the banner', () => {
  render(wrap(<CalendarReconnectBanner />));
  expect(screen.getByRole('alert').textContent).toContain('calendar@example.com');
  expect(screen.getByRole('link', { name: 'Calendar settings' }).getAttribute('href')).toBe(
    '/settings/calendar'
  );
  expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
  expect(mocks.start).not.toHaveBeenCalled();
});

it('groups failed accounts and disappears after reconnection', () => {
  mocks.connections.push({
    ...mocks.connections[0],
    id: 'cn_second',
    accountEmail: 'other@example.com',
  });
  const view = render(wrap(<CalendarReconnectBanner />));
  expect(screen.getByRole('alert').textContent).toContain('2 calendar accounts');
  mocks.connections = mocks.connections.map(c => ({ ...c, status: 'active' }));
  view.rerender(wrap(<CalendarReconnectBanner />));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('shows sync paused in settings, never up to date, and reconnects the affected provider', () => {
  render(wrap(<CalendarScreen />));
  expect(screen.getByText('Reconnect needed')).toBeTruthy();
  expect(screen.getByText(/Sync paused/)).toBeTruthy();
  expect(screen.queryByText('Up to date')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('Your calendar connection is no longer valid. Reconnect to resume syncing.');
  fireEvent.click(screen.getByRole('button', { name: /^Reconnect$/ }));
  expect(mocks.start).toHaveBeenCalledWith('google');
});

it('restores the healthy settings state after the connection is repaired', () => {
  const view = render(wrap(<CalendarScreen />));
  mocks.connections = mocks.connections.map(c => ({ ...c, status: 'active', statusReason: null }));
  view.rerender(wrap(<CalendarScreen />));
  expect(screen.queryByText('Reconnect needed')).toBeNull();
  expect(screen.queryByRole('button', { name: /^Reconnect$/ })).toBeNull();
  expect(screen.getByText(/Up to date/)).toBeTruthy();
});
