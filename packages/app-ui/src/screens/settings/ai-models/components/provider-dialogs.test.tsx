// @vitest-environment jsdom
import React from 'react';
import { AiModelsScreen } from '../ai-models-screen';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createApplicationI18n } from '@prismical/app-i18n';
import ChangeDefaultDialog from './change-default-dialog';
import InstanceFormDialog from './instance-form-dialog';

const mocks = vi.hoisted(() => ({
  enabled: true,
  flags: {} as Record<string, boolean>,
  update: vi.fn(),
  setDefault: vi.fn(),
  models: vi.fn((..._args: unknown[]) => ({
    data: [{ id: 'gpt-5', name: 'GPT 5', type: 'language' }],
    isLoading: false,
  })),
}));
vi.mock('@prismical/app-client', () => ({
  useFeatureFlags: () => ({ isEnabled: (key: string) => mocks.flags[key] ?? mocks.enabled }),
  useFeatureFlag: () => ({ enabled: true }),
  useEntitlements: () => ({ entitlements: { features: { byok: true } }, isResolved: true }),
  useInstanceModels: (...args: unknown[]) => mocks.models(...args),
  useCreateInstance: () => ({}),
  useUpdateInstance: () => ({ mutateAsync: mocks.update }),
  useModelDefaults: () => ({ data: {} }),
  useSetModelDefault: () => ({}),
  AUTO_SELECTION: { instanceId: 'prismical-cloud', modelId: 'auto' },
  PRISMICAL_CLOUD_INSTANCE_ID: 'prismical-cloud',
}));
vi.mock('./ai-models-store', () => {
  const instance = { id: 'inst_saved', provider: 'openai', label: 'Saved OpenAI', config: {} };
  return {
    AIModelsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useAIModels: () => ({
      instances: [instance],
      defaults: { formatting: { instanceId: instance.id, modelId: 'gpt-5' } },
      getInstance: () => instance,
      setDefault: mocks.setDefault,
    }),
  };
});
vi.mock('./default-card', () => ({ default: () => null }));
vi.mock('./connected-list', () => ({
  default: ({ onEdit }: { onEdit: (id: string) => void }) => (
    <button onClick={() => onEdit('inst_saved')}>Edit saved provider</button>
  ),
}));
vi.mock('./model-curation', () => ({ ModelCuration: () => null }));
vi.mock('./single-model-picker', () => ({ SingleModelPicker: () => null }));
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
  mocks.enabled = true;
  mocks.flags = {};
  vi.clearAllMocks();
});

async function mount(element: React.ReactElement) {
  const i18n = await createApplicationI18n('en');
  const view = (children: React.ReactElement) => (
    <I18nextProvider i18n={i18n}>{React.cloneElement(children)}</I18nextProvider>
  );
  return { ...render(view(element)), view };
}

it('drops a selected model source when its provider flag is revoked', async () => {
  const dialog = <ChangeDefaultDialog open onOpenChange={vi.fn()} useCase="formatting" />;
  const { rerender, view } = await mount(dialog);
  fireEvent.click(screen.getByRole('button', { name: /Saved OpenAI/ }));
  expect(mocks.models).toHaveBeenLastCalledWith('inst_saved', true);
  expect(screen.getByText('GPT 5')).toBeTruthy();
  mocks.enabled = false;
  rerender(view(dialog));
  expect(mocks.models).toHaveBeenLastCalledWith(undefined, false);
  expect(screen.queryByText('GPT 5')).toBeNull();
  expect(screen.queryByRole('button', { name: /Saved OpenAI/ })).toBeNull();
  expect(mocks.setDefault).not.toHaveBeenCalled();
});

it.each(['create', 'edit'] as const)(
  'unmounts the %s form when its provider is disabled',
  async kind => {
    const mode =
      kind === 'create' ? { kind, provider: 'openai' as const } : { kind, id: 'inst_saved' };
    const dialog = <InstanceFormDialog open onOpenChange={vi.fn()} mode={mode} />;
    const { rerender, view } = await mount(dialog);
    expect(screen.getByRole('dialog')).toBeTruthy();
    mocks.enabled = false;
    rerender(view(dialog));
    expect(screen.queryByRole('dialog')).toBeNull();
  }
);

it('does not open unfinished providers even when their visibility flag is enabled', async () => {
  await mount(
    <InstanceFormDialog
      open
      onOpenChange={vi.fn()}
      mode={{ kind: 'create', provider: 'anthropic' }}
    />
  );
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps a newer provider dialog open when a revoked form finishes saving', async () => {
  let finishSave!: () => void;
  mocks.update.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        finishSave = resolve;
      })
  );
  const page = <AiModelsScreen />;
  const { rerender, view } = await mount(page);
  fireEvent.click(screen.getByRole('button', { name: 'Edit saved provider' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(mocks.update).toHaveBeenCalledTimes(1);
  mocks.flags.openaiByok = false;
  rerender(view(page));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Google Gemini' }));
  const current = screen.getByRole('dialog');
  await act(async () => finishSave());
  expect(screen.getByRole('dialog')).toBe(current);
});
