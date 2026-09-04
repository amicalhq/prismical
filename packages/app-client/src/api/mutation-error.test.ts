import { describe, expect, it } from 'vitest';
import { createApplicationI18nSync } from '@prismical/app-i18n';
import { mutationErrorMessage } from './mutation-error';

describe('localized mutation feedback', () => {
  it('resolves a requested error in the active locale', () => {
    const { t } = createApplicationI18nSync('de');

    expect(mutationErrorMessage(t, 'common.mutationErrors.vocabularyAdd')).toBe(
      'Das Wort konnte nicht hinzugefügt werden. Bitte versuche es erneut.',
    );
  });

  it('uses the localized generic error when no specific key is supplied', () => {
    const { t } = createApplicationI18nSync('ja');

    expect(mutationErrorMessage(t)).toBe('問題が発生しました。もう一度お試しください。');
  });
});
