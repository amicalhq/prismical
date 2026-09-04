import { describe, expect, it, vi } from 'vitest';
import { supportedLocales } from '@prismical/app-i18n';
import { DEFAULT_DEVICE_SETTINGS, applicationLocaleSchema } from '@prismical/desktop-contracts';
import {
  createDesktopRendererI18n,
  persistDesktopLocalePreference,
} from '../../src/renderer/main/application-i18n';

describe('desktop renderer i18n bootstrap', () => {
  it('keeps the main-resolved startup locale while preserving the system preference', () => {
    const bootstrap = createDesktopRendererI18n('ja', '');
    expect(bootstrap.locale).toBe('ja');
    expect(bootstrap.preference).toBe('system');
    expect(bootstrap.instance.resolvedLanguage).toBe('ja');
    expect(bootstrap.instance.t('common.actions.save')).toBe('保存');
  });

  it('preserves a persisted supported selection', () => {
    const bootstrap = createDesktopRendererI18n('de', 'de');
    expect(bootstrap.preference).toBe('de');
    expect(bootstrap.instance.t('desktop.tray.open')).toBe('Prismical öffnen');
  });

  it('treats malformed preferences as system without changing the trusted startup locale', () => {
    const bootstrap = createDesktopRendererI18n('en', 'fr-CA');
    expect(bootstrap.preference).toBe('system');
    expect(bootstrap.locale).toBe('en');
  });

  it('keeps desktop IPC locales exactly aligned with the complete shared catalogs', () => {
    expect(applicationLocaleSchema.options).toEqual(supportedLocales);
  });
});

describe('persistDesktopLocalePreference', () => {
  it('writes the desktop sentinel and confirms the observed persisted value', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue({ ...DEFAULT_DEVICE_SETTINGS, language: '' });

    await persistDesktopLocalePreference({ get, set }, 'system');

    expect(set).toHaveBeenCalledWith({ language: '' });
    expect(get).toHaveBeenCalledOnce();
  });

  it('rejects when main could not persist the requested locale', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue({ ...DEFAULT_DEVICE_SETTINGS, language: '' });

    await expect(persistDesktopLocalePreference({ get, set }, 'de')).rejects.toThrow(
      'Desktop locale preference was not persisted'
    );
  });
});
