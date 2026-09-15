// @vitest-environment jsdom

// Ported from sidebar-quota.test.tsx when the meter became a ring plus a
// popover. The behaviours are the ones core's presentation contract guarantees,
// so they outlive the shape the client happens to draw them in - only HOW they
// are reached changed: the figures now live behind the ring rather than on the
// panel, so each case opens the menu first.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApplicationI18nProvider, createApplicationI18n } from '@prismical/app-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudTranscriptionQuota } from '@prismical/app-client';

const quotaMock = vi.fn<() => CloudTranscriptionQuota | null>();

vi.mock('@prismical/app-client', () => ({
  useCloudTranscriptionQuota: () => quotaMock(),
  useDesktopCapabilities: () => ({ has: () => false, featureFlags: null }),
}));

vi.mock('./app-link', () => ({
  AppLink: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { SidebarUsageControl } from './sidebar-foot-controls';

const HOUR = 3600;

const quota = (overrides: Partial<CloudTranscriptionQuota> = {}): CloudTranscriptionQuota => ({
  usedSeconds: 0,
  limitSeconds: 5 * HOUR,
  resetsAt: '2026-10-01T00:00:00.000Z',
  label: { kind: 'cloudTranscription' },
  href: '/settings/billing',
  action: { kind: 'upgradeUnlimited', href: '/settings/billing', external: false },
  ...overrides,
});

async function renderControl(value: CloudTranscriptionQuota | null) {
  quotaMock.mockReturnValue(value);
  const instance = await createApplicationI18n('en');
  return render(
    <ApplicationI18nProvider
      instance={instance}
      initialPreference="en"
      systemLocale="en-US"
      applyMode="immediate"
      persistPreference={async () => undefined}
    >
      <SidebarUsageControl />
    </ApplicationI18nProvider>
  );
}

/** The figures live behind the ring, so every assertion about them opens it. */
async function openMeter(value: CloudTranscriptionQuota | null) {
  const result = await renderControl(value);
  const trigger = screen.queryByRole('button');
  if (trigger) fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0 });
  return result;
}

const bar = () => screen.getByRole('progressbar');

afterEach(() => {
  cleanup();
  quotaMock.mockReset();
});

describe('SidebarUsageControl', () => {
  it('renders nothing when there is no meter to draw', async () => {
    await renderControl(null);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the remaining time on the trigger without opening anything', async () => {
    await renderControl(quota({ usedSeconds: 2 * HOUR }));
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('3 hrs left');
  });

  it('shows the remaining time and the resolved call to action', async () => {
    await openMeter(quota({ usedSeconds: 2 * HOUR }));
    expect(screen.getByText('3h left')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Upgrade to unlimited' })).toBeTruthy();
  });

  it('reports the reset date on its UTC calendar day, not the local one', async () => {
    await openMeter(quota({ usedSeconds: HOUR }));
    expect(bar().getAttribute('aria-label')).toContain('Oct 1');
  });

  it('never claims zero while time remains', async () => {
    await renderControl(quota({ usedSeconds: 5 * HOUR - 1 }));
    expect(screen.getByRole('button').getAttribute('aria-label')).not.toContain('No time left');
  });

  it('reads as a hard stop once the allowance is gone', async () => {
    await renderControl(quota({ usedSeconds: 5 * HOUR }));
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('No time left');
  });

  it('clamps an overshooting pooled allowance instead of overflowing the bar', async () => {
    // Another member can spend a pooled allowance between the gate and this read.
    await openMeter(quota({ usedSeconds: 9 * HOUR }));
    expect(Number(bar().getAttribute('aria-valuenow'))).toBe(0);
  });

  it('gives a member who cannot open billing no call to action', async () => {
    await openMeter(quota({ usedSeconds: HOUR, href: null, action: null }));
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('prefers server copy over the catalog so wording can change without a release', async () => {
    await openMeter(
      quota({
        usedSeconds: HOUR,
        label: { kind: 'cloudTranscription', text: 'Meeting minutes' },
        action: { kind: 'upgradeUnlimited', text: 'Go unlimited', href: '/x', external: false },
      })
    );
    expect(screen.getByText('Meeting minutes')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go unlimited' })).toBeTruthy();
  });

  it('renders no call to action for a kind it does not recognize', async () => {
    await openMeter(
      quota({
        usedSeconds: HOUR,
        action: { kind: 'from-a-newer-core', href: '/x', external: false },
      })
    );
    expect(screen.queryByRole('link')).toBeNull();
  });
});
