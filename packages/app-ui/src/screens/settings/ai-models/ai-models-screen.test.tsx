// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createApplicationI18n } from '@prismical/app-i18n';
import { AiModelsScreen } from './ai-models-screen';

const plan = vi.hoisted(() => ({ byok: false, enabled: true, resolved: true }));
vi.mock('@prismical/app-client', () => ({
  useFeatureFlag: () => ({ enabled: plan.enabled }),
  useEntitlements: () => ({ entitlements: { features: { byok: plan.byok } }, isResolved: plan.resolved }),
}));
vi.mock('../../../shell/app-link', () => ({
  AppLink: React.forwardRef<HTMLAnchorElement, React.ComponentProps<'a'>>(function TestLink(props, ref) {
    return <a ref={ref} {...props} />;
  }),
}));
vi.mock('./components/ai-models-store', () => ({ AIModelsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('./components/default-card', () => ({ default: ({ title }: { title: string }) => <button>{title}</button> }));
vi.mock('./components/connected-list', () => ({ default: () => <p>Connected provider preview</p> }));
vi.mock('./components/available-tiles', () => ({ default: () => <button>OpenAI</button> }));
vi.mock('./components/change-default-dialog', () => ({ default: () => null }));
vi.mock('./components/instance-form-dialog', () => ({ default: () => null }));
afterEach(() => { cleanup(); Object.assign(plan, { byok: false, enabled: true, resolved: true }); });

async function mount() {
  const i18n = await createApplicationI18n('en');
  return render(<I18nextProvider i18n={i18n}><AiModelsScreen providerSettings={<p>Device provider settings</p>} /></I18nextProvider>);
}

it('renders real settings sections behind the upgrade dialog for restricted plans', async () => {
  const { container } = await mount();
  expect(screen.getByRole('dialog', { name: 'Bring your own key' })).toBeTruthy();
  expect(screen.getByText('Defaults')).toBeTruthy();
  expect(screen.getByText('Connected provider preview')).toBeTruthy();
  expect(screen.getByText('Add a provider')).toBeTruthy();
  expect(container.querySelector('button')?.matches(':disabled')).toBe(true);
});

it('keeps paid-plan controls available without an upgrade dialog', async () => {
  plan.byok = true;
  await mount();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: 'OpenAI' }).matches(':disabled')).toBe(false);
});

it('does not gate the desktop local workspace or show cloud instance controls', async () => {
  plan.enabled = false;
  await mount();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByText('Add a provider')).toBeNull();
  expect(screen.getByText('Device provider settings')).toBeTruthy();
});
