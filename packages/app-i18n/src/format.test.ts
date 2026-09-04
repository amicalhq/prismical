import { describe, expect, it } from 'vitest';
import { createApplicationI18n } from './i18n';
import {
  formatApplicationBytes,
  formatApplicationDate,
  formatApplicationDateLabel,
  formatApplicationDuration,
  formatApplicationEventDateLabel,
  formatApplicationEventTimeRange,
  formatApplicationLastMet,
  formatApplicationNumber,
  formatApplicationRelativeDay,
  formatApplicationTime,
} from './format';

const now = new Date(2026, 6, 13, 12, 0, 0);

describe('locale-aware application formatting', () => {
  it('formats relative labels through the selected catalog', async () => {
    const de = await createApplicationI18n('de');

    expect(formatApplicationDateLabel(new Date(2026, 6, 12), now, 'de', de.t)).toBe('Gestern');
    expect(formatApplicationRelativeDay(new Date(2026, 6, 13), now, 'de', de.t)).toBe('Heute');
    expect(formatApplicationRelativeDay(new Date(2026, 6, 11), now, 'de', de.t)).toBe(
      'vor 2 Tagen'
    );
  });

  it('uses locale-specific absolute date, time, and number conventions', () => {
    const value = new Date(2026, 6, 6, 9, 5, 0);

    expect(formatApplicationDate(value, now, 'de')).toBe('6. Juli');
    expect(formatApplicationTime(value, 'de')).toBe('09:05');
    expect(formatApplicationNumber(1234.5, 'de')).toBe('1.234,5');
    expect(formatApplicationDate(value, now, 'ja')).toBe('7月6日');
  });

  it('formats durations without English abbreviations or spacing', async () => {
    const ja = await createApplicationI18n('ja');
    const de = await createApplicationI18n('de');

    expect(formatApplicationDuration(30_000, 'ja', ja.t)).toBe('1分未満');
    expect(formatApplicationDuration(65 * 60_000, 'ja', ja.t)).toBe('1時間5分');
    expect(formatApplicationDuration(65 * 60_000, 'de', de.t)).toBe('1 Std. 5 Min.');
    expect(formatApplicationDuration(null, 'de', de.t)).toBe('');
  });

  it('localizes calendar labels and event ranges', async () => {
    const ja = await createApplicationI18n('ja');
    const de = await createApplicationI18n('de');
    const tomorrow = new Date(2026, 6, 14, 9, 0, 0);

    expect(formatApplicationEventDateLabel(tomorrow, false, now, 'ja', ja.t)).toBe('明日');
    expect(
      formatApplicationEventTimeRange(
        new Date(2026, 6, 14, 9, 0, 0),
        new Date(2026, 6, 14, 10, 15, 0),
        false,
        'de',
        de.t
      )
    ).toBe('09:00–10:15');
    expect(formatApplicationEventTimeRange(tomorrow, tomorrow, true, 'ja', ja.t)).toBe('終日');
  });

  it('localizes compact directory recency labels', async () => {
    const de = await createApplicationI18n('de');
    const reference = new Date(2026, 6, 13).getTime();

    expect(
      formatApplicationLastMet(new Date(2026, 6, 12).toISOString(), reference, 'de', de.t)
    ).toBe('Gestern');
    expect(
      formatApplicationLastMet(new Date(2026, 5, 29).toISOString(), reference, 'de', de.t)
    ).toBe('vor 2 Wochen');
    expect(formatApplicationLastMet(null, reference, 'de', de.t)).toBe('—');
  });

  it('formats byte sizes with Intl units (base 1024) per locale', () => {
    expect(formatApplicationBytes(148 * 1024 * 1024, 'en')).toBe('148 MB');
    expect(formatApplicationBytes(1.5 * 1024 ** 3, 'en')).toBe('1.5 GB');
    // de separates the unit with a no-break space (U+00A0).
    expect(formatApplicationBytes(1.5 * 1024 ** 3, 'de')).toBe('1,5\u00a0GB');
    expect(formatApplicationBytes(512, 'en')).toBe('512 byte');
    expect(formatApplicationBytes(0, 'ja')).toBe('0 byte');
  });
});
