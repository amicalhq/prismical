import { describe, expect, it } from 'vitest';
import { createApplicationI18n } from './i18n';
import {
  formatApplicationBytes,
  formatApplicationDate,
  formatApplicationDateLabel,
  formatApplicationDuration,
  formatApplicationDurationCompact,
  formatApplicationEventDateLabel,
  formatApplicationEventTimeRange,
  formatApplicationLastMet,
  formatApplicationNumber,
  formatApplicationRelativeDay,
  formatApplicationTime,
  formatApplicationTimeAgoShort,
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

  // The compact form sits at the right edge of a note row, so every step has to stay short and a
  // future timestamp must never render as a negative age.
  it('steps a compact age through minutes, hours and days before falling back to a date', async () => {
    const en = await createApplicationI18n('en');
    const ago = (ms: number) =>
      formatApplicationTimeAgoShort(new Date(now.getTime() - ms), now, 'en', en.t);

    expect(ago(0)).toBe('now');
    expect(ago(59_000)).toBe('now');
    expect(ago(60_000)).toBe('1m');
    expect(ago(59 * 60_000)).toBe('59m');
    expect(ago(60 * 60_000)).toBe('1h');
    expect(ago(23 * 3_600_000)).toBe('23h');
    expect(ago(24 * 3_600_000)).toBe('1d');
    expect(ago(6 * 86_400_000)).toBe('6d');
    // Seven days over, it becomes the plain date rather than a number that keeps growing.
    expect(ago(7 * 86_400_000)).toBe('Jul 6');
    // A clock skew reads as "now", never "-1m".
    expect(formatApplicationTimeAgoShort(new Date(now.getTime() + 30_000), now, 'en', en.t)).toBe(
      'now'
    );
  });

  it('carries the year on a compact age from another year', async () => {
    const en = await createApplicationI18n('en');
    expect(formatApplicationTimeAgoShort(new Date(2025, 6, 6), now, 'en', en.t)).toBe('Jul 6, 2025');
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

  it('narrows durations per locale without hard-coding h/m', async () => {
    const en = await createApplicationI18n('en');
    const ja = await createApplicationI18n('ja');
    const de = await createApplicationI18n('de');

    expect(formatApplicationDurationCompact((4 * 60 + 58) * 60_000, 'en', en.t)).toBe('4h 58m');
    expect(formatApplicationDurationCompact(58 * 60_000, 'en', en.t)).toBe('58m');
    expect(formatApplicationDurationCompact(4 * 60 * 60_000, 'en', en.t)).toBe('4h');
    // Each locale keeps its own narrow unit and its own joining, from Intl and the catalogue —
    // German narrows the minute but not the hour, and Japanese joins with no space.
    expect(formatApplicationDurationCompact(65 * 60_000, 'de', de.t)).toBe('1h 5 Min.');
    expect(formatApplicationDurationCompact(65 * 60_000, 'ja', ja.t)).toBe('1h5m');
    // Sub-minute stays the catalogue sentence, and an absent value stays empty.
    expect(formatApplicationDurationCompact(30_000, 'en', en.t)).toBe('<1 min');
    expect(formatApplicationDurationCompact(null, 'en', en.t)).toBe('');
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
