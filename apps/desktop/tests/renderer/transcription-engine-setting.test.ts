// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DEVICE_SETTINGS } from '@prismical/app-contracts';
import { TranscriptionEngineSetting } from '../../src/renderer/main/app/settings/transcription-engine-setting';

const settings = vi.hoisted(() => {
  const setKey = vi.fn();
  const hasKey = vi.fn();
  return {
    set: vi.fn(),
    setKey,
    hasKey,
    caps: { has: () => true, transcriptionByok: { setKey, hasKey } },
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@prismical/app-client', () => ({
  useDesktopCapabilities: () => settings.caps,
  useDeviceSettings: () => ({
    settings: {
      ...DEFAULT_DEVICE_SETTINGS,
      transcription: {
        ...DEFAULT_DEVICE_SETTINGS.transcription,
        engine: 'byok',
        byokBaseUrl: 'https://original.test/v1',
        byokModel: 'whisper-1',
      },
    },
    set: settings.set,
  }),
}));
vi.mock('../../src/renderer/main/app/desktop-env', () => ({
  useDesktopEnv: () => ({ appMode: 'local' }),
}));
vi.mock('@prismical/app-ui/shell/app-link', () => ({ AppLink: 'a' }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
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

describe('BYOK endpoint credential binding', () => {
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
    await act(async () => root!.render(createElement(TranscriptionEngineSetting)));
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
    acknowledge!();
  });
});
