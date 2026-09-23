// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DEVICE_SETTINGS, type LocalModelsState } from '@prismical/app-contracts';
import { LocalModelsScreen } from '../../src/renderer/main/app/settings/local-models-screen';
import { TranscriptionSettingsProvider, useTranscriptionSetting } from '../../src/renderer/main/app/settings/use-transcription-setting';

const state = vi.hoisted(() => ({
  mode: 'cloud' as 'cloud' | 'local',
  transcription: {
    engine: 'cloud' as 'cloud' | 'local' | 'byok',
    modelId: null as string | null,
    byokBaseUrl: null as string | null,
    byokModel: null as string | null,
  },
  set: vi.fn(),
  subscribe: vi.fn(),
}));
const snapshot: LocalModelsState = {
  modelsDir: '/tmp/models',
  models: [
    {
      id: 'whisper-base-en',
      name: 'Whisper Base (English)',
      filename: 'ggml-base.en.bin',
      sizeBytes: 147_964_211,
      kind: 'whisper',
      installed: true,
      installedAt: '2026-01-01T00:00:00Z',
      download: null,
    },
  ],
};

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@prismical/app-i18n', () => ({
  formatApplicationBytes: (bytes: number) => String(bytes),
  useApplicationLocale: () => ({ resolvedLocale: 'en' }),
}));
vi.mock('@prismical/app-client', () => ({
  useDesktopCapabilities: () => ({
    localModels: { subscribe: state.subscribe, delete: vi.fn(), download: vi.fn(), cancelDownload: vi.fn() },
  }),
  useDeviceSettings: () => ({
    settings: {
      ...DEFAULT_DEVICE_SETTINGS,
      transcription: state.transcription,
    },
    set: state.set,
  }),
}));
vi.mock('../../src/renderer/main/app/desktop-env', () => ({
  useDesktopEnv: () => ({ appMode: state.mode }),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.set.mockResolvedValue(undefined);
  state.subscribe.mockImplementation((listener: (value: LocalModelsState) => void) => {
    listener(snapshot);
    return () => {};
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  state.mode = 'cloud';
  state.transcription = { ...DEFAULT_DEVICE_SETTINGS.transcription };
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function SettingsHarness() {
  const { transcription, patch } = useTranscriptionSetting();
  return createElement(LocalModelsScreen, { transcription, onPatch: patch });
}

async function mount() {
  await act(async () => root.render(createElement(TranscriptionSettingsProvider, null, createElement(SettingsHarness))));
  return container;
}

describe('Local models transcription selection', () => {
  it('selecting an installed model switches a cloud desktop to local transcription', async () => {
    const view = await mount();
    expect(view.querySelector('[data-testid="local-model-active"]')).toBeNull();
    const useModel = [...view.querySelectorAll('button')].find(button => button.textContent === 'desktop.localModels.useModel');
    expect(useModel).toBeDefined();
    await act(async () => useModel!.click());
    expect(state.set).toHaveBeenCalledWith({
      transcription: { ...DEFAULT_DEVICE_SETTINGS.transcription, engine: 'local', modelId: 'whisper-base-en' },
    });
  });

  it('shows the active local model without a separate account-mode switch', async () => {
    state.transcription.engine = 'local';
    const view = await mount();
    expect(view.querySelector('[data-testid="local-model-active"]')).not.toBeNull();
    expect(view.textContent).not.toContain('desktop.localModels.useAccountModel');
  });

  it('does not mark Whisper active while a direct provider is selected in local mode', async () => {
    state.mode = 'local';
    state.transcription.engine = 'byok';
    const view = await mount();
    expect(view.querySelector('[data-testid="local-model-active"]')).toBeNull();
    const useModel = [...view.querySelectorAll('button')].find(button => button.textContent === 'desktop.localModels.useModel');
    await act(async () => useModel!.click());
    expect(state.set).toHaveBeenCalledWith({
      transcription: { ...DEFAULT_DEVICE_SETTINGS.transcription, engine: 'local', modelId: 'whisper-base-en' },
    });
  });

  it('does not offer account transcription in local mode', async () => {
    state.mode = 'local';
    const view = await mount();
    expect(view.querySelector('[data-testid="local-model-active"]')).not.toBeNull();
    expect(view.textContent).not.toContain('desktop.localModels.useAccountModel');
  });
});
