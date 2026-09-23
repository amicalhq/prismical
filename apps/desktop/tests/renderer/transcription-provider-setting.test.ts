// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DEVICE_SETTINGS, type LocalModelsState } from '@prismical/app-contracts';
import { TranscriptionProviderSetting } from '../../src/renderer/main/app/settings/transcription-provider-setting';
import { LocalModelsScreen } from '../../src/renderer/main/app/settings/local-models-screen';
import { TranscriptionSettingsProvider, useTranscriptionSetting } from '../../src/renderer/main/app/settings/use-transcription-setting';

const settings = vi.hoisted(() => {
  const setKey = vi.fn();
  const hasKey = vi.fn();
  return {
    transcription: {
      engine: 'byok' as 'cloud' | 'local' | 'byok',
      modelId: null as string | null,
      byokBaseUrl: 'https://original.test/v1',
      byokModel: 'whisper-1',
    },
    set: vi.fn(),
    setKey,
    hasKey,
    caps: {
      has: () => true,
      transcriptionByok: { setKey, hasKey },
      localModels: { subscribe: vi.fn(), delete: vi.fn(), download: vi.fn(), cancelDownload: vi.fn() },
    },
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@prismical/app-client', () => ({
  useDesktopCapabilities: () => settings.caps,
  useDeviceSettings: () => ({
    settings: {
      ...DEFAULT_DEVICE_SETTINGS,
      transcription: settings.transcription,
    },
    set: settings.set,
  }),
}));
vi.mock('@prismical/app-i18n', () => ({
  formatApplicationBytes: (bytes: number) => String(bytes),
  useApplicationLocale: () => ({ resolvedLocale: 'en' }),
}));
vi.mock('../../src/renderer/main/app/desktop-env', () => ({
  useDesktopEnv: () => ({ appMode: 'local' }),
}));

function SettingsHarness({ withWhisper = false, onlyWhisper = false }: { withWhisper?: boolean; onlyWhisper?: boolean }) {
  const { transcription, patch } = useTranscriptionSetting();
  return createElement(Fragment, null,
    withWhisper || onlyWhisper ? createElement(LocalModelsScreen, { transcription, onPatch: patch }) : null,
    onlyWhisper ? null : createElement(TranscriptionProviderSetting, { transcription, onPatch: patch }),
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
beforeEach(() => {
  settings.transcription = {
    ...DEFAULT_DEVICE_SETTINGS.transcription,
    engine: 'byok',
    byokBaseUrl: 'https://original.test/v1',
    byokModel: 'whisper-1',
  };
  settings.set.mockResolvedValue(undefined);
  settings.caps.localModels.subscribe.mockImplementation((listener: (value: LocalModelsState) => void) => {
    listener({ modelsDir: '/tmp/models', models: [{
      id: 'whisper-base-en', name: 'Whisper Base', filename: 'ggml-base.en.bin',
      sizeBytes: 147_964_211, kind: 'whisper', installed: true,
      installedAt: '2026-01-01T00:00:00Z', download: null,
    }] });
    return () => {};
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const changeInput = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('local transcription provider', () => {
  it('selects the configured provider explicitly without changing its endpoint or model', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    settings.transcription.engine = 'local';
    settings.hasKey.mockResolvedValue(true);
    settings.set.mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(TranscriptionSettingsProvider, null, createElement(SettingsHarness))));
    const useModel = [...container.querySelectorAll('button')].find(
      button => button.textContent === 'desktop.transcriptionProvider.useModel'
    )!;
    await act(async () => useModel.click());
    expect(settings.set).toHaveBeenCalledWith({ transcription: {
      ...DEFAULT_DEVICE_SETTINGS.transcription,
      engine: 'byok',
      byokBaseUrl: 'https://original.test/v1',
      byokModel: 'whisper-1',
    } });
    expect(container.querySelector('[role="radio"]')).toBeNull();
  });

  it('activates the latest endpoint and model while blur saves await acknowledgement', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    settings.transcription.engine = 'local';
    settings.hasKey.mockResolvedValue(false);
    const acknowledgements: Array<() => void> = [];
    settings.set.mockImplementation(() => new Promise<void>(resolve => {
      acknowledgements.push(resolve);
    }));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(TranscriptionSettingsProvider, null, createElement(SettingsHarness))));
    const endpointInput = container.querySelector<HTMLInputElement>('#byok-base-url')!;
    const modelInput = container.querySelector<HTMLInputElement>('#byok-model')!;
    await act(async () => {
      endpointInput.focus();
      changeInput(endpointInput, 'https://replacement.test/v1');
    });
    await act(async () => modelInput.focus());
    await act(async () => changeInput(modelInput, 'gpt-4o-transcribe'));
    const useModel = [...container.querySelectorAll('button')].find(
      button => button.textContent === 'desktop.transcriptionProvider.useModel'
    )!;
    // Focus moves before click, committing the model while IPC still has not
    // acknowledged either field. Activation must not restore the old snapshot.
    await act(async () => {
      useModel.focus();
      useModel.click();
    });
    expect(settings.set).toHaveBeenCalledTimes(1);
    while (acknowledgements.length > 0) {
      await act(async () => acknowledgements.shift()!());
    }
    expect(settings.set).toHaveBeenLastCalledWith({ transcription: {
      ...DEFAULT_DEVICE_SETTINGS.transcription,
      engine: 'byok',
      byokBaseUrl: 'https://replacement.test/v1',
      byokModel: 'gpt-4o-transcribe',
    } });
  });

  it('keeps pending provider fields when another card selects Whisper', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    settings.hasKey.mockResolvedValue(false);
    const acknowledgements: Array<() => void> = [];
    settings.set.mockImplementation(() => new Promise<void>(resolve => {
      acknowledgements.push(resolve);
    }));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(TranscriptionSettingsProvider, null, createElement(SettingsHarness, { withWhisper: true }))));
    const endpointInput = container.querySelector<HTMLInputElement>('#byok-base-url')!;
    const modelInput = container.querySelector<HTMLInputElement>('#byok-model')!;
    await act(async () => {
      endpointInput.focus();
      changeInput(endpointInput, 'https://replacement.test/v1');
    });
    await act(async () => modelInput.focus());
    await act(async () => changeInput(modelInput, 'gpt-4o-transcribe'));
    const useWhisper = [...container.querySelectorAll('button')].find(
      button => button.textContent === 'desktop.localModels.useModel'
    )!;
    await act(async () => {
      useWhisper.focus();
      useWhisper.click();
    });
    expect(settings.set).toHaveBeenCalledTimes(1);
    while (acknowledgements.length > 0) {
      await act(async () => acknowledgements.shift()!());
    }
    expect(settings.set).toHaveBeenLastCalledWith({ transcription: {
      ...DEFAULT_DEVICE_SETTINGS.transcription,
      engine: 'local',
      modelId: 'whisper-base-en',
      byokBaseUrl: 'https://replacement.test/v1',
      byokModel: 'gpt-4o-transcribe',
    } });
  });

  it('retains pending provider edits when navigating to the model manager', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    settings.hasKey.mockResolvedValue(false);
    const acknowledgements: Array<() => void> = [];
    settings.set.mockImplementation(() => new Promise<void>(resolve => {
      acknowledgements.push(resolve);
    }));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(
      TranscriptionSettingsProvider, null, createElement(SettingsHarness),
    )));
    const modelInput = container.querySelector<HTMLInputElement>('#byok-model')!;
    await act(async () => {
      modelInput.focus();
      changeInput(modelInput, 'gpt-4o-transcribe');
    });
    await act(async () => modelInput.blur());
    expect(settings.set).toHaveBeenCalledTimes(1);
    // Keep the common settings owner mounted while the route child changes.
    await act(async () => root!.render(createElement(
      TranscriptionSettingsProvider, null, createElement(SettingsHarness, { onlyWhisper: true }),
    )));
    expect(container.querySelector('#byok-model')).toBeNull();
    const useWhisper = [...container.querySelectorAll('button')].find(
      button => button.textContent === 'desktop.localModels.useModel'
    )!;
    await act(async () => useWhisper.click());
    expect(settings.set).toHaveBeenCalledTimes(1);
    while (acknowledgements.length > 0) {
      await act(async () => acknowledgements.shift()!());
    }
    expect(settings.set).toHaveBeenLastCalledWith({ transcription: {
      ...DEFAULT_DEVICE_SETTINGS.transcription,
      engine: 'local',
      modelId: 'whisper-base-en',
      byokBaseUrl: 'https://original.test/v1',
      byokModel: 'gpt-4o-transcribe',
    } });
  });

  it('saves the visible endpoint while its settings acknowledgement is pending', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    settings.hasKey.mockResolvedValue(false);
    settings.setKey.mockResolvedValue(undefined);
    let acknowledge: (() => void) | undefined;
    settings.set.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          acknowledge = resolve;
        })
    );
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(TranscriptionSettingsProvider, null, createElement(SettingsHarness))));
    const keyInput = container.querySelector<HTMLInputElement>('#byok-api-key')!;
    const endpointInput = container.querySelector<HTMLInputElement>('#byok-base-url')!;
    await act(async () => changeInput(keyInput, 'replacement-key'));
    await act(async () => {
      endpointInput.focus();
      changeInput(endpointInput, 'https://replacement.test/v1');
    });
    await act(async () => endpointInput.blur());
    expect(settings.set).toHaveBeenCalledWith(
      expect.objectContaining({
        transcription: expect.objectContaining({ byokBaseUrl: 'https://replacement.test/v1' }),
      })
    );
    expect(endpointInput.value).toBe('https://replacement.test/v1');
    const save = [...container.querySelectorAll('button')].find(
      button => button.textContent === 'desktop.transcriptionEngine.byok.saveKey'
    )!;
    await act(async () => save.click());
    expect(settings.setKey).toHaveBeenCalledWith('replacement-key', 'https://replacement.test/v1');
    await act(async () => acknowledge!());
  });
});
