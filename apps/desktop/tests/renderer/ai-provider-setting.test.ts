// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DEVICE_SETTINGS, type AiProviderKind } from '@prismical/app-contracts';
import { AiProviderSetting } from '../../src/renderer/main/app/settings/ai-provider-setting';

const mocks = vi.hoisted(() => ({
  provider: 'openai' as AiProviderKind,
  set: vi.fn().mockResolvedValue(undefined),
  listModels: vi.fn().mockResolvedValue({ models: ['gpt-5'], error: null }),
  hasKey: vi.fn().mockResolvedValue(false),
  invalidateQueries: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));
vi.mock('@prismical/app-client', () => {
  const caps = {
    has: () => true,
    aiProvider: { listModels: mocks.listModels, hasKey: mocks.hasKey },
  };
  return {
    useDesktopCapabilities: () => caps,
    useDeviceSettings: () => ({
      settings: {
        ...DEFAULT_DEVICE_SETTINGS,
        ai: { ...DEFAULT_DEVICE_SETTINGS.ai, provider: mocks.provider },
      },
      set: mocks.set,
    }),
  };
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.provider = 'openai';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('device AI providers', () => {
  it('offers all supported local providers without rollout access', async () => {
    await act(async () => root.render(createElement(AiProviderSetting)));
    expect([...container.querySelectorAll('[role="radio"]')].map(el => el.id)).toEqual([
      'ai-provider-openai',
      'ai-provider-anthropic',
      'ai-provider-openrouter',
      'ai-provider-openai-compatible',
      'ai-provider-ollama',
    ]);
    expect(container.querySelector('[data-testid="ai-provider-fields"]')).not.toBeNull();
    expect(mocks.listModels).toHaveBeenCalledWith('openai', false);
  });

  it.each(['anthropic', 'openrouter', 'ollama', 'openai-compatible'] as const)(
    'shows saved %s controls and lets the user choose OpenAI',
    async provider => {
      mocks.provider = provider;
      await act(async () => root.render(createElement(AiProviderSetting)));
      expect(container.querySelector('[data-testid="ai-provider-fields"]')).not.toBeNull();
      expect(mocks.listModels).toHaveBeenCalledWith(provider, false);
      if (provider === 'ollama') expect(mocks.hasKey).not.toHaveBeenCalled();
      else expect(mocks.hasKey).toHaveBeenCalledWith(provider);
      expect(mocks.set).not.toHaveBeenCalled();
      await act(async () =>
        container.querySelector<HTMLButtonElement>('#ai-provider-openai')!.click()
      );
      expect(mocks.set).toHaveBeenCalledWith({
        ai: { provider: 'openai', model: null, baseUrl: null },
      });
    }
  );

  it('selects OpenRouter with its own key field and no base URL field', async () => {
    await act(async () => root.render(createElement(AiProviderSetting)));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('#ai-provider-openrouter')!.click()
    );
    expect(mocks.set).toHaveBeenCalledWith({
      ai: { provider: 'openrouter', model: null, baseUrl: null },
    });
    mocks.provider = 'openrouter';
    await act(async () => root.render(createElement(AiProviderSetting)));
    expect(container.querySelector('#ai-provider-api-key')).not.toBeNull();
    expect(container.querySelector('#ai-provider-base-url')).toBeNull();
    expect(mocks.hasKey).toHaveBeenCalledWith('openrouter');
  });
});
