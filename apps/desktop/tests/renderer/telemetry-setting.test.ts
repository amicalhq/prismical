// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { createApplicationI18nSync } from '@prismical/app-i18n';
import type { TelemetryState } from '@prismical/desktop-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRendererTelemetry } from '../../src/renderer/telemetry';
import { TelemetrySetting } from '../../src/renderer/main/app/settings/telemetry-setting';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let stop: (() => void) | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  stop?.();
  stop = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
const signedOut: TelemetryState = {
  revision: 1, available: true, enabled: false, signedIn: false, preference: false, canChangePreference: true,
};

async function mount(state = signedOut) {
  let current = state;
  let push: (state: TelemetryState) => void = () => {};
  const set = vi.fn(async ({ telemetryOptOut }: { telemetryOptOut: boolean }) => {
    current = { ...current, revision: current.revision + 1, preference: !telemetryOptOut, enabled: !telemetryOptOut };
    push(current);
  });
  const getState = vi.fn(async () => current);
  Object.assign(window, { desktop: {
    telemetry: { getState, captureException: vi.fn().mockResolvedValue(undefined), onChanged: (listener: typeof push) => { push = listener; return () => {}; } },
    settings: { set },
  } });
  stop = installRendererTelemetry(window.desktop.telemetry);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(I18nextProvider, {
    i18n: createApplicationI18nSync('en'),
  }, createElement(TelemetrySetting))));
  return { container, set, getState, push: (next: TelemetryState) => push(next) };
}

describe('signed-out telemetry setting', () => {
  it('shows the saved preference and persists an explicit opt-in', async () => {
    const { container, set } = await mount();
    const toggle = container.querySelector('[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(set).toHaveBeenCalledWith({ telemetryOptOut: false });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('hides immediately when main reports a real signed-in account', async () => {
    const { container, push } = await mount();
    expect(container.querySelector('[role="switch"]')).not.toBeNull();
    await act(async () => push({ ...signedOut, revision: 2, enabled: true, signedIn: true, canChangePreference: false }));
    expect(container.querySelector('[role="switch"]')).toBeNull();
  });

  it('does not offer an opt-in that cannot enable this build', async () => {
    const { container } = await mount({ ...signedOut, available: false, canChangePreference: false });
    expect(container.querySelector('[role="switch"]')).toBeNull();
  });

  it('shows failure when settings persistence leaves the preference unchanged', async () => {
    const { container, set } = await mount();
    set.mockImplementationOnce(async () => {});
    await act(async () => container.querySelector('[role="switch"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
  });
});
