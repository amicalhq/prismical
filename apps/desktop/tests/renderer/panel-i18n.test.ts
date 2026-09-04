import { createApplicationI18nSync } from '@prismical/app-i18n';
import { describe, expect, it, vi } from 'vitest';
import { bootstrapPanelI18n } from '../../src/renderer/panel-i18n';

describe('restricted panel i18n bootstrap', () => {
  it('pulls a guaranteed initial state before creating the localized renderer', async () => {
    const getState = vi.fn().mockResolvedValue({ locale: 'de' as const, value: 1 });
    const { initialState, instance } = await bootstrapPanelI18n(getState);

    expect(getState).toHaveBeenCalledOnce();
    expect(initialState).toEqual({ locale: 'de', value: 1 });
    expect(instance.language).toBe('de');
    expect(instance.t('desktop.widget.record')).toBe('Aufnehmen');
  });

  it('retries English when the preferred locale cannot initialize', async () => {
    const getState = vi.fn().mockResolvedValue({ locale: 'de' as const, value: 1 });
    const createI18n = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('German catalog failed');
      })
      .mockImplementation(createApplicationI18nSync);

    const { locale, instance } = await bootstrapPanelI18n(getState, createI18n);

    expect(createI18n).toHaveBeenNthCalledWith(1, 'de');
    expect(createI18n).toHaveBeenNthCalledWith(2, 'en');
    expect(locale).toBe('en');
    expect(instance.t('desktop.widget.record')).toBe('Record');
  });
});
