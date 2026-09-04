import { createApplicationI18nSync } from '@prismical/app-i18n';
import { describe, expect, it, vi } from 'vitest';
import { initializeDesktopI18n } from '../../src/shared/application-i18n';

describe('initializeDesktopI18n', () => {
  it('returns the preferred supported locale when initialization succeeds', () => {
    const result = initializeDesktopI18n('ja-JP');

    expect(result.locale).toBe('ja');
    expect(result.instance.t('common.actions.save')).toBe('保存');
  });

  it('retries exactly once in English after a preferred-locale failure', () => {
    const createI18n = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('Japanese catalog failed');
      })
      .mockImplementation(createApplicationI18nSync);

    const result = initializeDesktopI18n('ja-JP', createI18n);

    expect(createI18n).toHaveBeenNthCalledWith(1, 'ja');
    expect(createI18n).toHaveBeenNthCalledWith(2, 'en');
    expect(result.locale).toBe('en');
    expect(result.instance.t('common.actions.save')).toBe('Save');
  });

  it('does not retry when English itself cannot initialize', () => {
    const createI18n = vi.fn(() => {
      throw new Error('i18next unavailable');
    });

    expect(() => initializeDesktopI18n('en-US', createI18n)).toThrow('i18next unavailable');
    expect(createI18n).toHaveBeenCalledOnce();
  });
});
