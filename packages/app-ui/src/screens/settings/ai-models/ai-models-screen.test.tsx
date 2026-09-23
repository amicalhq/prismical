// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createApplicationI18n } from '@prismical/app-i18n';
import { AiModelsScreen } from './ai-models-screen';

const plan = vi.hoisted(() => ({ byok: false, enabled: true, resolved: true, planExternalId: 'plan_free' }));
vi.mock('@prismical/app-client', () => ({
  useFeatureFlag: () => ({ enabled: plan.enabled }),
  useEntitlements: () => ({
    entitlements: { planExternalId: plan.planExternalId, features: { byok: plan.byok } },
    isResolved: plan.resolved,
  }),
}));
vi.mock('../../../shell/app-link', () => ({
  AppLink: React.forwardRef<HTMLAnchorElement, React.ComponentProps<'a'>>(function TestLink(props, ref) {
    return <a ref={ref} {...props} />;
  }),
}));
vi.mock('./components/ai-models-store', () => ({ AIModelsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('./components/default-card', () => ({
  default: ({ title, onChange }: { title: string; onChange: () => void }) => <button onClick={onChange}>{title}</button>,
}));
vi.mock('./components/connected-list', () => ({
  default: ({ byokAccess }: { byokAccess: string }) => <p>Connected list: {byokAccess}</p>,
}));
vi.mock('./components/available-tiles', () => ({
  default: ({ onLocked, onAddCloud, byokAccess }: { onLocked: () => void; onAddCloud: (p: string) => void; byokAccess: string }) => (
    <>
      <button onClick={() => (byokAccess === 'allowed' ? onAddCloud('openai') : onLocked())}>OpenAI</button>
      {/* Bypasses the tile's own lock to prove the page never mounts the key form on a locked plan. */}
      <button onClick={() => onAddCloud('deepgram')}>Force add</button>
    </>
  ),
}));
vi.mock('./components/change-default-dialog', () => ({
  default: ({ useCase, byokAccess, onLocked }: { useCase: string; byokAccess: string; onLocked: () => void }) => (
    <div>
      <p>Picker for {useCase}: {byokAccess}</p>
      <button onClick={onLocked}>Locked instance</button>
    </div>
  ),
}));
vi.mock('./components/instance-form-dialog', () => ({
  default: ({ mode }: { mode: { provider?: string } | null }) => (mode ? <p>Form for {mode.provider}</p> : null),
}));
afterEach(() => { cleanup(); Object.assign(plan, { byok: false, enabled: true, resolved: true, planExternalId: 'plan_free' }); });

async function mount() {
  const i18n = await createApplicationI18n('en');
  return render(<I18nextProvider i18n={i18n}><AiModelsScreen providerSettings={<p>Device provider settings</p>} /></I18nextProvider>);
}

it('keeps the page usable on a plan without BYOK and locks only connecting a provider', async () => {
  await mount();
  // No page-level wall: nothing is inert and no dialog is open.
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.querySelector('[inert]')).toBeNull();
  expect(screen.getByText('Connected list: locked')).toBeTruthy();
  expect(screen.getByText('Bring your own key is in Pro')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Upgrade to Pro' }).getAttribute('href')).toBe('/settings/billing');

  // Defaults stay reachable: Auto is open on every plan. A locked instance in the picker closes
  // it and hands off to the upgrade explanation.
  fireEvent.click(screen.getByRole('button', { name: 'Transcription' }));
  expect(screen.getByText('Picker for transcription: locked')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Locked instance' }));
  expect(screen.queryByText(/Picker for/)).toBeNull();
  expect(screen.getByRole('dialog', { name: 'Bring your own key' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

  // Even a stray create request never mounts the key form without BYOK.
  fireEvent.click(screen.getByRole('button', { name: 'Force add' }));
  expect(screen.queryByText(/Form for/)).toBeNull();

  // A locked tile explains the plan in a dismissible dialog rather than opening the form.
  fireEvent.click(screen.getByRole('button', { name: 'OpenAI' }));
  const dialog = screen.getByRole('dialog', { name: 'Bring your own key' });
  expect(screen.getByText('Available in Pro')).toBeTruthy();
  expect(screen.queryByText(/Form for/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
  expect(dialog.isConnected).toBe(false);
});

it('keeps paid-plan controls open without an upsell', async () => {
  plan.byok = true;
  await mount();
  expect(screen.queryByText('Bring your own key is in Pro')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'OpenAI' }));
  expect(screen.getByText('Form for openai')).toBeTruthy();
  expect(screen.queryByRole('dialog', { name: 'Bring your own key' })).toBeNull();
});

it('does not upsell while the plan is still loading', async () => {
  plan.resolved = false;
  await mount();
  expect(screen.queryByText('Bring your own key is in Pro')).toBeNull();
  expect(screen.getByText('Connected list: pending')).toBeTruthy();
});

it('does not gate the desktop local workspace or show cloud instance controls', async () => {
  plan.enabled = false;
  await mount();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByText('Add a provider')).toBeNull();
  expect(screen.queryByText('Bring your own key is in Pro')).toBeNull();
  expect(screen.getByText('Device provider settings')).toBeTruthy();
});

it('sends a lifetime-deal tier to its listing with tier copy instead of Pro billing', async () => {
  plan.planExternalId = 'plan_appsumo_tier_1';
  await mount();
  expect(screen.getByText('Bring your own key is on higher tiers')).toBeTruthy();
  const link = screen.getByRole('link', { name: 'Upgrade your tier' });
  expect(link.getAttribute('href')).toBe('https://appsumo.com/products/prismical/');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(screen.queryByRole('link', { name: 'Upgrade to Pro' })).toBeNull();
});
