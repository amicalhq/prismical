// @vitest-environment jsdom

import { createApplicationI18nSync } from '@prismical/app-i18n';
import { describe, expect, it, vi } from 'vitest';
import { mountRendererBootstrapFailure } from '../../src/renderer/main/bootstrap-failure';

describe('desktop renderer bootstrap failure', () => {
  it('renders localized recovery UI when main environment initialization fails', () => {
    const root = document.createElement('div');
    const reload = vi.fn();

    mountRendererBootstrapFailure(root, 'de-DE', reload);

    expect(document.documentElement.lang).toBe('de');
    expect(root.textContent).toContain('Prismical konnte nicht gestartet werden');
    expect(root.textContent).toContain('Das App-Fenster konnte nicht geladen werden.');
    const button = root.querySelector('button');
    expect(button?.textContent).toBe('Neu laden');
    button?.click();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('retries English when the detected locale cannot initialize', () => {
    const root = document.createElement('div');
    const createI18n = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('German catalog failed');
      })
      .mockImplementation(createApplicationI18nSync);

    mountRendererBootstrapFailure(root, 'de-DE', vi.fn(), createI18n);

    expect(createI18n).toHaveBeenNthCalledWith(1, 'de');
    expect(createI18n).toHaveBeenNthCalledWith(2, 'en');
    expect(document.documentElement.lang).toBe('en');
    expect(root.textContent).toContain('Prismical failed to start');
  });

  it('renders a terminal English recovery surface when i18next cannot initialize', () => {
    const root = document.createElement('div');

    mountRendererBootstrapFailure(root, 'ja-JP', vi.fn(), () => {
      throw new Error('i18next unavailable');
    });

    expect(document.documentElement.lang).toBe('en');
    expect(root.textContent).toContain('The app window could not be loaded.');
    expect(root.querySelector('button')?.textContent).toBe('Reload');
  });
});
