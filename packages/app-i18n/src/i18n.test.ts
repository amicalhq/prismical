import { describe, expect, it, vi } from 'vitest';
import { catalogs } from './resources';
import { createApplicationI18n, createApplicationI18nSync, getI18nOptions } from './i18n';

describe('application i18n instance', () => {
  it('can initialize synchronously for renderer boot without a blank frame', () => {
    const instance = createApplicationI18nSync('ja');

    expect(instance.isInitialized).toBe(true);
    expect(instance.t('common.actions.save')).toBe('保存');
  });

  it('disables the dependency support notice in application output', () => {
    expect(getI18nOptions('en').showSupportNotice).toBe(false);
  });

  it('translates from the selected locale', async () => {
    const instance = await createApplicationI18n('de');

    expect(instance.t('common.actions.save')).toBe(catalogs.de.common.actions.save);
    expect(instance.resolvedLanguage).toBe('de');
  });

  it('translates vocabulary management copy and preserves entry interpolation', async () => {
    const instance = await createApplicationI18n('de');

    expect(instance.t('settings.vocabulary.screen.title')).toBe('Wörterbuch');
    expect(
      instance.t('settings.vocabulary.delete.personalDescription', {
        entry: 'k8s → Kubernetes',
      })
    ).toContain('„k8s → Kubernetes“');
  });

  it('translates web-only authentication, onboarding, and public-note copy', async () => {
    const instance = await createApplicationI18n('de');

    expect(instance.t('auth.flow.signingIn')).toBe('Anmeldung läuft…');
    expect(instance.t('web.getApps.title')).toBe('Prismical überall nutzen');
    expect(instance.t('web.publicNote.viewOnly')).toBe('Nur ansehen');
  });

  it('falls back to English when a selected-locale resource is missing', async () => {
    const instance = await createApplicationI18n('de');
    instance.removeResourceBundle('de', 'translation');

    expect(instance.t('common.actions.save')).toBe(catalogs.en.common.actions.save);
  });

  it('reports an unknown key and never renders the raw semantic key', async () => {
    const onMissingKey = vi.fn();
    const instance = await createApplicationI18n('ja', { onMissingKey });

    expect(instance.t('not.a.real.key' as never)).toBe(catalogs.ja.common.errors.generic);
    expect(onMissingKey).toHaveBeenCalledWith('not.a.real.key');
  });

  it('normalizes an unsupported requested locale to English', async () => {
    const instance = await createApplicationI18n('fr-CA');

    expect(instance.resolvedLanguage).toBe('en');
    expect(instance.t('common.actions.save')).toBe(catalogs.en.common.actions.save);
  });
});
