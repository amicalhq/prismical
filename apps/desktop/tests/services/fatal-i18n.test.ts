import { describe, expect, it } from 'vitest';
import { fatalDialogCopy, fatalDialogTitle } from '../../src/main/fatal-i18n';

describe('fatal startup dialog localization', () => {
  it('uses the nearest supported system locale with English fallback', () => {
    expect(fatalDialogTitle('zh-Hant-HK')).toBe('Prismical 無法啟動');
    expect(fatalDialogTitle('fr-FR')).toBe('Prismical failed to start');
  });

  it('localizes the recovery guidance around untranslated technical details', () => {
    expect(fatalDialogCopy('de-DE')).toEqual({
      title: 'Prismical konnte nicht gestartet werden',
      description:
        'Prismical konnte den Start nicht abschließen. Beende die App und öffne sie erneut. Wenn das Problem weiterhin auftritt, teile dem Support die technischen Details mit.',
      detailsLabel: 'Technische Details',
    });
  });
});
