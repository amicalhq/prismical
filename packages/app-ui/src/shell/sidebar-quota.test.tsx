// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { ApplicationI18nProvider, createApplicationI18n } from '@prismical/app-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudTranscriptionQuota } from '@prismical/app-client';

const quotaMock = vi.fn<() => CloudTranscriptionQuota | null>();

vi.mock('@prismical/app-client', () => ({
  useCloudTranscriptionQuota: () => quotaMock(),
}));

vi.mock('./app-link', () => ({
  AppLink: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { SidebarQuota } from './sidebar-quota';

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

async function renderQuota(value: CloudTranscriptionQuota | null) {
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
      <SidebarQuota />
    </ApplicationI18nProvider>
  );
}

const bar = () => screen.getByRole('progressbar');

afterEach(() => {
  cleanup();
  quotaMock.mockReset();
});

describe('SidebarQuota', () => {
  it('renders nothing when there is no meter to draw', async () => {
    const { container } = await renderQuota(null);
    expect(container.textContent).toBe('');
  });

  it('shows the remaining time and the resolved call to action', async () => {
    await renderQuota(quota({ usedSeconds: 3 * HOUR + 20 * 60 }));
    expect(screen.getByText('Cloud transcription')).toBeTruthy();
    // The meter itself is narrow; the accessible name spells the units out.
    expect(screen.getByText('1h 40m left')).toBeTruthy();
    expect(screen.getByLabelText('Cloud transcription 1 hr 40 min left')).toBeTruthy();
    expect(screen.getByText('Upgrade to unlimited')).toBeTruthy();
    expect(bar().getAttribute('aria-valuenow')).toBe('67');
  });

  it('reports the reset date on its UTC calendar day, not the local one', async () => {
    // The bucket is half-open, so a period ending 2026-10-01T00:00Z resets ON 1 October. Formatted
    // in local time west of UTC that instant renders as 30 September — a day the meter never
    // resets — so the date is pinned to the UTC calendar day and must read Oct 1 in any timezone.
    await renderQuota(quota({ usedSeconds: 0 }));
    expect(bar().getAttribute('aria-label')).toContain('Oct 1');
  });

  it('never claims zero while time remains', async () => {
    // A sub-minute remainder must not read as an empty allowance: recording still works.
    await renderQuota(quota({ usedSeconds: 5 * HOUR - 45 }));
    expect(screen.queryByText('No time left')).toBeNull();
    expect(screen.getByText('<1 min left')).toBeTruthy();
  });

  it('reads as a hard stop once the allowance is gone', async () => {
    await renderQuota(quota({ usedSeconds: 5 * HOUR }));
    expect(screen.getByText('No time left')).toBeTruthy();
    expect(bar().getAttribute('aria-valuenow')).toBe('100');
  });

  it('clamps an overshooting pooled allowance instead of overflowing the bar', async () => {
    await renderQuota(quota({ usedSeconds: 6 * HOUR }));
    expect(bar().getAttribute('aria-valuenow')).toBe('100');
    expect(screen.getByText('No time left')).toBeTruthy();
  });

  it('gives a member who cannot open billing no link and no call to action', async () => {
    const { container } = await renderQuota(quota({ href: null, action: null }));
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(screen.getByText('Cloud transcription')).toBeTruthy();
  });

  it('prefers server copy over the catalog so wording can change without a release', async () => {
    await renderQuota(
      quota({
        label: { kind: 'cloudTranscription', text: 'Meeting transcription' },
        action: { kind: 'upgradeUnlimited', text: 'Go unlimited', href: '/x', external: false },
      })
    );
    expect(screen.getByText('Meeting transcription')).toBeTruthy();
    expect(screen.getByText('Go unlimited')).toBeTruthy();
  });

  it('renders no call to action for a kind it does not recognize', async () => {
    await renderQuota(quota({ action: { kind: 'somethingNewer', href: '/x', external: false } }));
    expect(screen.queryByText(/upgrade/i)).toBeNull();
  });
});
