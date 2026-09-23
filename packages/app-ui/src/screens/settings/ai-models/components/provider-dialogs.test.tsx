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
  plan: 'plan_free',
  flags: {} as Record<string, boolean>,
  update: vi.fn(),
  create: vi.fn(),
  setDefaultMutation: vi.fn(),
  setDefault: vi.fn(),
  models: vi.fn((..._args: unknown[]) => ({
    data: [{ id: 'gpt-5', name: 'GPT 5', type: 'language' }],
    isLoading: false,
  })),
}));
vi.mock('@prismical/app-client', () => ({
  useFeatureFlags: () => ({ isEnabled: (key: string) => mocks.flags[key] ?? mocks.enabled }),
  useFeatureFlag: () => ({ enabled: true }),
  useEntitlements: () => ({
    entitlements: { planExternalId: mocks.plan, features: { byok: true } },
    isResolved: true,
  }),
  useInstanceModels: (...args: unknown[]) => mocks.models(...args),
  useCreateInstance: () => ({ mutateAsync: mocks.create }),
  useUpdateInstance: () => ({ mutateAsync: mocks.update }),
  useModelDefaults: () => ({ data: {} }),
  useSetModelDefault: () => ({ mutateAsync: mocks.setDefaultMutation }),
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
vi.mock('../../../../shell/app-link', () => ({ AppLink: 'a' }));
vi.mock('./default-card', () => ({ default: () => null }));
vi.mock('./connected-list', () => ({
  default: ({ onEdit }: { onEdit: (id: string) => void }) => (
    <button onClick={() => onEdit('inst_saved')}>Edit saved provider</button>
  ),
}));
vi.mock('./model-curation', () => ({ ModelCuration: () => null }));
vi.mock('./single-model-picker', () => ({
  SingleModelPicker: ({ modelType, onChange }: { modelType: string; onChange: (modelId: string) => void }) => (
    <button onClick={() => onChange(modelType === 'transcription' ? 'whisper-1' : 'gpt-5')}>
      Choose {modelType} model
    </button>
  ),
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
  mocks.enabled = true;
  mocks.flags = {};
  mocks.plan = 'plan_free';
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
  const dialog = (
    <ChangeDefaultDialog
      open
      onOpenChange={vi.fn()}
      useCase="formatting"
      byokAccess="allowed"
      onLocked={vi.fn()}
    />
  );
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

it('activates account transcription when an account model is selected', async () => {
  let finishSave!: () => void;
  mocks.setDefault.mockImplementationOnce(() => new Promise<void>(resolve => { finishSave = resolve; }));
  const onTranscriptionSelected = vi.fn();
  await mount(
    <ChangeDefaultDialog
      open
      onOpenChange={vi.fn()}
      useCase="transcription"
      byokAccess="allowed"
      onLocked={vi.fn()}
      onTranscriptionSelected={onTranscriptionSelected}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: /Prismical Cloud/ }));
  expect(mocks.setDefault).toHaveBeenCalledWith('transcription', {
    instanceId: 'prismical-cloud',
    modelId: 'auto',
  });
  expect(onTranscriptionSelected).not.toHaveBeenCalled();
  await act(async () => finishSave());
  expect(onTranscriptionSelected).toHaveBeenCalledOnce();
});

it('keeps on-device transcription active when saving the account model fails', async () => {
  mocks.setDefault.mockRejectedValueOnce(new Error('save failed'));
  const onTranscriptionSelected = vi.fn();
  await mount(
    <ChangeDefaultDialog
      open
      onOpenChange={vi.fn()}
      useCase="transcription"
      byokAccess="allowed"
      onLocked={vi.fn()}
      onTranscriptionSelected={onTranscriptionSelected}
    />
  );
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /Prismical Cloud/ })));
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(onTranscriptionSelected).not.toHaveBeenCalled();
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

it('keeps Auto selectable and routes a locked instance to the upgrade explanation', async () => {
  const onLocked = vi.fn();
  const onOpenChange = vi.fn();
  await mount(
    <ChangeDefaultDialog
      open
      onOpenChange={onOpenChange}
      useCase="formatting"
      byokAccess="locked"
      onLocked={onLocked}
    />
  );
  const row = screen.getByRole('button', { name: /Saved OpenAI/ });
  expect(row.textContent).toContain('Pro');
  fireEvent.click(row);
  expect(onLocked).toHaveBeenCalledTimes(1);
  expect(mocks.models).toHaveBeenLastCalledWith(undefined, false);
  expect(screen.queryByText('GPT 5')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Prismical Cloud/ }));
  expect(mocks.setDefault).toHaveBeenCalledWith('formatting', {
    instanceId: 'prismical-cloud',
    modelId: 'auto',
  });
});

it('holds instance rows inert without upselling while the plan is still loading', async () => {
  const onLocked = vi.fn();
  await mount(
    <ChangeDefaultDialog
      open
      onOpenChange={vi.fn()}
      useCase="formatting"
      byokAccess="pending"
      onLocked={onLocked}
    />
  );
  const row = screen.getByRole('button', { name: /Saved OpenAI/ });
  expect((row as HTMLButtonElement).disabled).toBe(true);
  expect(row.textContent).not.toContain('Pro');
  fireEvent.click(row);
  expect(onLocked).not.toHaveBeenCalled();
});

it('badges a locked instance with the tier on a lifetime-deal plan', async () => {
  mocks.plan = 'plan_appsumo_tier_1';
  await mount(
    <ChangeDefaultDialog
      open
      onOpenChange={vi.fn()}
      useCase="formatting"
      byokAccess="locked"
      onLocked={vi.fn()}
    />
  );
  const row = screen.getByRole('button', { name: /Saved OpenAI/ });
  expect(row.textContent).toContain('Higher tier');
  expect(row.textContent).not.toContain('Pro');
});


it.each(['close and reopen', 'unmount and reopen'] as const)(
  'ignores a pending transcription selection after %s',
  async dismissal => {
    let finishSave!: () => void;
    mocks.setDefault.mockImplementationOnce(() => new Promise<void>(resolve => { finishSave = resolve; }));
    const onTranscriptionSelected = vi.fn();
    const onOpenChange = vi.fn();
    const dialog = (
      <ChangeDefaultDialog
        open
        onOpenChange={onOpenChange}
        useCase="transcription"
        byokAccess="allowed"
        onLocked={vi.fn()}
        onTranscriptionSelected={onTranscriptionSelected}
      />
    );
    const { rerender, view } = await mount(dialog);
    fireEvent.click(screen.getByRole('button', { name: /Prismical Cloud/ }));
    expect(mocks.setDefault).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(view(dismissal === 'close and reopen' ? React.cloneElement(dialog, { open: false }) : <></>));
    rerender(view(dialog));
    const reopened = screen.getByRole('dialog');
    onOpenChange.mockClear();
    await act(async () => finishSave());
    expect(onTranscriptionSelected).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBe(reopened);
  }
);

it('does not activate transcription when a dismissed provider wizard finishes saving', async () => {
  mocks.create.mockResolvedValueOnce({ id: 'inst_new' });
  let finishSave!: () => void;
  mocks.setDefaultMutation.mockImplementationOnce(() => new Promise<void>(resolve => { finishSave = resolve; }));
  const onTranscriptionSelected = vi.fn();
  const onOpenChange = vi.fn();
  const { unmount } = await mount(
    <InstanceFormDialog
      open
      mode={{ kind: 'create', provider: 'deepgram' }}
      onOpenChange={onOpenChange}
      onTranscriptionSelected={onTranscriptionSelected}
    />
  );
  fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Meeting transcription' } });
  fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'test-key' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect' })));
  fireEvent.click(screen.getByRole('button', { name: 'Choose transcription model' }));
  fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
  expect(mocks.setDefaultMutation).toHaveBeenCalledWith({
    useCase: 'transcription', instanceId: 'inst_new', modelId: 'whisper-1',
  });
  unmount();
  await act(async () => finishSave());
  expect(onTranscriptionSelected).not.toHaveBeenCalled();
  expect(onOpenChange).not.toHaveBeenCalled();
});

it.each([false, true])(
  'keeps transcription activation independent of a later formatting save (dismissed: %s)',
  async dismissed => {
    let finishTranscription!: () => void;
    let finishFormatting!: () => void;
    mocks.setDefaultMutation
      .mockImplementationOnce(() => new Promise<void>(resolve => { finishTranscription = resolve; }))
      .mockImplementationOnce(() => new Promise<void>(resolve => { finishFormatting = resolve; }));
    const onTranscriptionSelected = vi.fn();
    const { unmount } = await mount(
      <InstanceFormDialog
        open
        mode={{ kind: 'edit', id: 'inst_saved' }}
        onOpenChange={vi.fn()}
        onTranscriptionSelected={onTranscriptionSelected}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^Transcription default/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose transcription model' }));
    fireEvent.click(screen.getByRole('button', { name: /^Text generation \(Skills\) default/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose language model' }));
    expect(mocks.setDefaultMutation).toHaveBeenNthCalledWith(1, {
      useCase: 'transcription', instanceId: 'inst_saved', modelId: 'whisper-1',
    });
    expect(mocks.setDefaultMutation).toHaveBeenNthCalledWith(2, {
      useCase: 'formatting', instanceId: 'inst_saved', modelId: 'gpt-5',
    });
    if (dismissed) unmount();
    await act(async () => finishFormatting());
    expect(onTranscriptionSelected).not.toHaveBeenCalled();
    await act(async () => finishTranscription());
    expect(onTranscriptionSelected).toHaveBeenCalledTimes(dismissed ? 0 : 1);
  }
);


it.each(['locked', 'pending'] as const)('selects installed on-device models without account mutations when BYOK is %s', async byokAccess => {
  const onSelect = vi.fn();
  const onOpenChange = vi.fn();
  const onTranscriptionSelected = vi.fn();
  const onLocked = vi.fn();
  await mount(
    <ChangeDefaultDialog
      open
      useCase="transcription"
      byokAccess={byokAccess}
      onLocked={onLocked}
      onOpenChange={onOpenChange}
      onTranscriptionSelected={onTranscriptionSelected}
      deviceTranscription={{
        models: [
          { id: 'base-en', name: 'Whisper Base (English)', installed: true },
          { id: 'large', name: 'Whisper Large', installed: false },
        ],
        active: false,
        loading: false,
        selectedModelId: null,
        onSelect,
      }}
    />
  );
  expect(screen.queryByRole('button', { name: /Whisper Large/ })).toBeNull();
  expect(screen.getByRole('link', { name: 'Manage local models' }).getAttribute('href')).toBe('/settings/local-models');
  fireEvent.click(screen.getByRole('button', { name: /Whisper Base \(English\)/ }));
  expect(onSelect).toHaveBeenCalledWith('base-en');
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(mocks.setDefault).not.toHaveBeenCalled();
  expect(onTranscriptionSelected).not.toHaveBeenCalled();
  expect(onLocked).not.toHaveBeenCalled();
});
