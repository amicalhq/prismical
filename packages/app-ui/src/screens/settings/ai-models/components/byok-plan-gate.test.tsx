// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createApplicationI18n } from '@prismical/app-i18n';
import ByokPlanGate from './byok-plan-gate';

vi.mock('../../../../shell/app-link', () => ({
  AppLink: React.forwardRef<HTMLAnchorElement, React.ComponentProps<'a'>>(function TestLink(props, ref) { return <a ref={ref} {...props} />; }),
}));
afterEach(cleanup);

async function setup(blocked: boolean, pending = false) {
  const i18n = await createApplicationI18n('en');
  const view = (isBlocked: boolean, isPending = false) => (
    <I18nextProvider i18n={i18n}>
      <nav aria-label="Settings"><a href="/settings/preferences">Preferences</a></nav>
      <ByokPlanGate blocked={isBlocked} pending={isPending}>
        <h2>Provider preview</h2>
        <button>Connect provider</button>
        <a href="mailto:test@example.com">Request provider</a>
      </ByokPlanGate>
    </I18nextProvider>
  );
  return { ...render(view(blocked, pending)), view };
}

it('keeps settings visible but inert behind an accessible, non-dismissible upgrade dialog', async () => {
  const { container } = await setup(true);
  expect(screen.getByText('Provider preview')).toBeTruthy();
  expect(container.querySelector('button')?.matches(':disabled')).toBe(true);
  expect(screen.getByText('Request provider').closest('[inert]')).toBeTruthy();
  const dialog = screen.getByRole('dialog', { name: 'Bring your own key' });
  expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
  expect(screen.getByText('Available in Pro')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Upgrade to Pro' }).getAttribute('href')).toBe('/settings/billing');
  expect(screen.getByRole('link', { name: 'Back to settings' }).getAttribute('href')).toBe('/settings/preferences');
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  const sidebar = screen.getByRole('navigation', { name: 'Settings' });
  expect(sidebar.closest('[inert], [aria-hidden="true"]')).toBeNull();
  expect(dialog.getAttribute('aria-modal')).toBe('false');
  expect(container.contains(dialog)).toBe(true);
  const preferences = screen.getByRole('link', { name: 'Preferences' });
  preferences.focus();
  expect(document.activeElement).toBe(preferences);
  expect(screen.getByRole('dialog')).toBe(dialog);
});

it('removes the gate and restores controls when the plan gains access', async () => {
  const { container, rerender, view } = await setup(true);
  rerender(view(false));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: 'Connect provider' }).matches(':disabled')).toBe(false);
  expect(container.querySelector('[inert]')).toBeNull();
});

it('disables controls while the plan loads without flashing an upgrade prompt', async () => {
  const { container } = await setup(false, true);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(container.querySelector('button')?.matches(':disabled')).toBe(true);
  expect(container.querySelector('[inert]')).toBeTruthy();
});
