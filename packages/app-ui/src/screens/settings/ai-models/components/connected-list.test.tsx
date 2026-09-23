// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createApplicationI18n } from '@prismical/app-i18n';
import ConnectedList from './connected-list';

vi.mock('@prismical/app-client', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true, isResolved: true }),
}));
vi.mock('./ai-models-store', () => ({
  useAIModels: () => ({
    instances: [{ id: 'inst_saved', provider: 'openai', label: 'Work key', config: { apiKey: 'sk-abcdefgh1234' } }],
    loading: false,
    removeInstance: vi.fn(),
  }),
}));
beforeEach(() =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
);
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

async function mount(byokAccess: 'allowed' | 'locked' | 'pending', onEdit = vi.fn()) {
  const i18n = await createApplicationI18n('en');
  render(
    <I18nextProvider i18n={i18n}>
      <ConnectedList byokAccess={byokAccess} onEdit={onEdit} />
    </I18nextProvider>
  );
  return onEdit;
}

function openMenu() {
  const trigger = screen.getByRole('button', { name: 'Work key options' });
  fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0 });
}

it('marks an instance kept after a downgrade and leaves only removal', async () => {
  await mount('locked');
  expect(screen.getByText('Not in your plan')).toBeTruthy();
  openMenu();
  expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
});

it('keeps editing on a plan with BYOK', async () => {
  const onEdit = await mount('allowed');
  expect(screen.queryByText('Not in your plan')).toBeNull();
  openMenu();
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
  expect(onEdit).toHaveBeenCalledWith('inst_saved');
});

it('holds editing without marking the row while the plan loads', async () => {
  await mount('pending');
  expect(screen.queryByText('Not in your plan')).toBeNull();
  openMenu();
  expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
});
