// @vitest-environment jsdom

// The chip's shortening rule. It reads a plan NAME for meaning, which is the one
// thing this package otherwise leaves to core, so it is worth pinning: the cases
// below are the whole contract, and anything beyond them should go to core
// rather than growing another branch here.

import { cleanup, render, screen } from '@testing-library/react';
import { ApplicationI18nProvider, createApplicationI18n } from '@prismical/app-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Plan = { isFreeTier: boolean; displayName: string };

const planMock = vi.fn<() => { data: { plan: Plan } | undefined }>();

vi.mock('@prismical/app-client', () => ({
  usePlanAccess: () => planMock(),
}));

vi.mock('./app-link', () => ({
  AppLink: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { SidebarPlanBadge, SidebarPlanPill } from './sidebar-plan-pill';

async function renderPill(plan: Plan | null) {
  planMock.mockReturnValue(plan ? { data: { plan } } : { data: undefined });
  const instance = await createApplicationI18n('en');
  return render(
    <ApplicationI18nProvider
      instance={instance}
      initialPreference="en"
      systemLocale="en-US"
      applyMode="immediate"
      persistPreference={async () => undefined}
    >
      <SidebarPlanPill />
    </ApplicationI18nProvider>
  );
}

async function renderBadge(plan: Plan | null) {
  planMock.mockReturnValue(plan ? { data: { plan } } : { data: undefined });
  const instance = await createApplicationI18n('en');
  return render(
    <ApplicationI18nProvider
      instance={instance}
      initialPreference="en"
      systemLocale="en-US"
      applyMode="immediate"
      persistPreference={async () => undefined}
    >
      <SidebarPlanBadge />
    </ApplicationI18nProvider>
  );
}

/** The chip's text without the separator the name is prefixed with. */
const label = () =>
  document.querySelector('span[title]')?.textContent?.replace(/^\s*·\s*/, '') ?? '';

afterEach(() => {
  cleanup();
  planMock.mockReset();
});

describe('SidebarPlanPill', () => {
  it('shows nothing while the plan is unknown, rather than a placeholder that would change', async () => {
    await renderPill(null);
    expect(document.body.textContent).toBe('');
  });

  it('says nothing on free - the offer is the badge in the menu', async () => {
    await renderPill({ isFreeTier: true, displayName: 'Free Plan' });
    expect(document.body.textContent).toBe('');
  });

  it('drops the word every plan shares', async () => {
    await renderPill({ isFreeTier: false, displayName: 'Pro Plan' });
    expect(label()).toBe('Pro');
  });

  it('drops the partner name, leaving the tier that actually differs', async () => {
    await renderPill({ isFreeTier: false, displayName: 'AppSumo Tier 1' });
    expect(label()).toBe('Tier 1');
  });

  it('keeps a name that carries neither', async () => {
    await renderPill({ isFreeTier: false, displayName: 'Enterprise' });
    expect(label()).toBe('Enterprise');
  });

  it('cuts a name too long for the row, at the limit rather than at a word', async () => {
    await renderPill({ isFreeTier: false, displayName: 'Enterprise Unlimited' });
    expect(label()).toBe('Enterprise U...');
  });

  it('keeps the full name reachable once it has been shortened', async () => {
    await renderPill({ isFreeTier: false, displayName: 'AppSumo Tier 1' });
    expect(document.querySelector('span[title]')?.getAttribute('title')).toBe('AppSumo Tier 1');
  });

  it('never empties a name that is nothing but the dropped words', async () => {
    await renderPill({ isFreeTier: false, displayName: 'Plan' });
    expect(label()).toBe('Plan');
  });
});

// The offer moved here from the sidebar foot, where it was a link nested inside
// the account menu's own trigger button: invalid markup, it opened the menu on
// the way to billing (Radix opens on pointerdown, which a click guard never
// sees), and screen readers announced one control named "Naomi Upgrade".
describe('SidebarPlanBadge', () => {
  it('offers the upgrade on free', async () => {
    await renderBadge({ isFreeTier: true, displayName: 'Free Plan' });
    expect(screen.getByText('Upgrade')).toBeTruthy();
  });

  it('says nothing on a paid plan', async () => {
    await renderBadge({ isFreeTier: false, displayName: 'Pro Plan' });
    expect(document.body.textContent).toBe('');
  });

  it('says nothing while the plan is unknown', async () => {
    await renderBadge(null);
    expect(document.body.textContent).toBe('');
  });

  it('is never a link: the row it sits on, or the trigger it sits in, navigates', async () => {
    await renderBadge({ isFreeTier: true, displayName: 'Free Plan' });
    expect(document.querySelector('a')).toBeNull();
    expect(document.querySelector('button')).toBeNull();
  });
});
