// @vitest-environment jsdom

// Carried over from nav-secondary.test.tsx when the row of link icons became one
// help menu. The support fallback is the case worth keeping: it is the only thing
// between a shell with no chat integration and no way to reach anyone at all, and
// nothing else in the suite covers it.

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// The control reads the desktop capability port to decide whether to offer the
// app download; a web shell reports no native capabilities.
vi.mock('@prismical/app-client', () => ({
  useCloudTranscriptionQuota: () => null,
  useDesktopCapabilities: () => ({ has: () => false, featureFlags: null }),
}));

const replay = vi.hoisted(() => vi.fn());
vi.mock('../onboarding/first-note-walkthrough', () => ({ useWalkthroughReplay: () => replay }));

vi.mock('./app-link', () => ({
  AppLink: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { SidebarHelpControl } from './sidebar-foot-controls';

afterEach(cleanup);

/** The menu only mounts its items once opened. */
function openMenu(node: React.ReactElement) {
  const view = render(node);
  const trigger = screen.getByRole('button', { name: 'navigation.secondary.help' });
  fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0 });
  return view;
}

describe('help menu support action', () => {
  it('falls back to email for a shell with no chat integration', () => {
    openMenu(<SidebarHelpControl />);
    const mail = screen
      .getAllByRole('menuitem')
      .find(item => item.getAttribute('href')?.startsWith('mailto:'));
    expect(mail?.getAttribute('href')).toBe('mailto:help@prismical.ai');
  });

  it('gives the row to the platform when one is supplied', () => {
    openMenu(<SidebarHelpControl supportAction={<button type="button">Chat</button>} />);
    expect(screen.getByRole('menuitem', { name: 'Chat' })).toBeTruthy();
    expect(
      screen.queryAllByRole('menuitem').some(i => i.getAttribute('href')?.startsWith('mailto:'))
    ).toBe(false);
  });

  it('offers docs, community and the apps alongside it', () => {
    openMenu(<SidebarHelpControl />);
    const labels = screen.getAllByRole('menuitem').map(item => item.textContent?.trim());
    expect(labels).toContain('navigation.secondary.docs');
    expect(labels).toContain('Discord');
    expect(labels).toContain('navigation.secondary.downloadApps');
  });
});

it('starts the quick start tour from Help', () => {
  openMenu(<SidebarHelpControl />);
  const labels = screen.getAllByRole('menuitem').map(item => item.textContent?.trim());
  expect(labels.indexOf('onboarding.replayTitle') + 1).toBe(labels.indexOf('navigation.secondary.downloadApps'));
  fireEvent.click(screen.getByRole('menuitem', { name: 'onboarding.replayTitle' }));
  expect(replay).toHaveBeenCalledOnce();
});
