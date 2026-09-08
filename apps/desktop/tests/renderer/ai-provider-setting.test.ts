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

describe('device AI provider rollout', () => {
  it('only offers publicly enabled providers', async () => {
    await act(async () => root.render(createElement(AiProviderSetting)));
    expect([...container.querySelectorAll('[role="radio"]')].map(el => el.id)).toEqual([
      'ai-provider-openai',
    ]);
    expect(container.querySelector('[data-testid="ai-provider-fields"]')).not.toBeNull();
    expect(mocks.listModels).toHaveBeenCalledWith('openai', false);
  });

  it.each(['anthropic', 'ollama', 'openai-compatible'] as const)(
    'hides saved %s controls and lets the user choose OpenAI',
    async provider => {
      mocks.provider = provider;
      await act(async () => root.render(createElement(AiProviderSetting)));
      expect(container.querySelector('[data-testid="ai-provider-fields"]')).toBeNull();
      expect(mocks.listModels).not.toHaveBeenCalled();
      expect(mocks.hasKey).not.toHaveBeenCalled();
      expect(mocks.set).not.toHaveBeenCalled();
      await act(async () =>
        container.querySelector<HTMLButtonElement>('#ai-provider-openai')!.click()
      );
      expect(mocks.set).toHaveBeenCalledWith({
        ai: { provider: 'openai', model: null, baseUrl: null },
      });
    }
  );
});
