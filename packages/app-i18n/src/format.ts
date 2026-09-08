import type { TFunction } from 'i18next';
import type { SupportedLocale } from './locale';

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function formatApplicationDate(
  date: Date,
  referenceDate: Date,
  locale: SupportedLocale
): string {
  const sameYear = date.getFullYear() === referenceDate.getFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date);
}

export function formatApplicationDateLabel(
  date: Date,
  referenceDate: Date,
  locale: SupportedLocale,
  t: TFunction
): string {
  if (isSameDay(date, referenceDate)) return t('common.time.today');
  const yesterday = new Date(referenceDate);
  yesterday.setDate(referenceDate.getDate() - 1);
  if (isSameDay(date, yesterday)) return t('common.time.yesterday');
  return formatApplicationDate(date, referenceDate, locale);
}

export function formatApplicationRelativeDay(
  date: Date,
  now: Date,
  locale: SupportedLocale,
  t: TFunction
): string {
  if (isSameDay(date, now)) return t('common.time.today');

  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return t('common.time.today');
  if (days === 1) return t('common.time.yesterday');
  if (days < 7) return t('common.time.daysAgo', { count: days });
  return formatApplicationDate(date, now, locale);
}

export function formatApplicationTime(date: Date, locale: SupportedLocale): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function eventDayKey(date: Date, isAllDay = false): number {
  return isAllDay
    ? date.getUTCFullYear() * 10_000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate()
    : date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate();
}

export function formatApplicationEventDateLabel(
  date: Date,
  isAllDay: boolean,
  referenceDate: Date,
  locale: SupportedLocale,
  t: TFunction,
  options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }
): string {
  const tomorrow = new Date(referenceDate);
  tomorrow.setDate(referenceDate.getDate() + 1);
  const key = eventDayKey(date, isAllDay);
  if (key === eventDayKey(referenceDate)) return t('common.time.today');
  if (key === eventDayKey(tomorrow)) return t('common.time.tomorrow');

  const displayDate = isAllDay
    ? new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    : date;
  return new Intl.DateTimeFormat(locale, options).format(displayDate);
}

export function formatApplicationEventTimeRange(
  start: Date,
  end: Date,
  isAllDay: boolean,
  locale: SupportedLocale,
  t: TFunction
): string {
  if (isAllDay) return t('common.time.allDay');
  return t('common.time.range', {
    start: formatApplicationTime(start, locale),
    end: formatApplicationTime(end, locale),
  });
}

export function formatApplicationNumber(
  value: number,
  locale: SupportedLocale,
  options?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

/**
 * A byte count as a locale-formatted size with a unit (base 1024, so the
 * catalogue's "148 MB" model reads as 148 MB). The unit label comes from
 * Intl — never a hard-coded "MB"/"GB" literal in a screen.
 */
export function formatApplicationBytes(bytes: number, locale: SupportedLocale): string {
  let value = Math.max(0, bytes);
  let unit: (typeof BYTE_UNITS)[number] = 'byte';
  for (const next of BYTE_UNITS.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: unit === 'byte' ? 0 : value < 10 ? 1 : 0,
  }).format(value);
}

export function formatApplicationDuration(
  milliseconds: number | null,
  locale: SupportedLocale,
  t: TFunction
): string {
  if (milliseconds === null || milliseconds <= 0) return '';

  const totalMinutes = Math.floor(milliseconds / 60_000);
  if (totalMinutes < 1) return t('common.time.lessThanMinute');

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const minuteLabel = t('common.time.minutes', {
    count: formatApplicationNumber(minutes, locale),
  });
  if (hours === 0) return minuteLabel;

  const hourLabel = t(hours === 1 ? 'common.time.hours' : 'common.time.hoursPlural', {
    count: formatApplicationNumber(hours, locale),
  });
  if (minutes === 0) return hourLabel;
  return t('common.time.durationHoursMinutes', {
    hours: hourLabel,
    minutes: minuteLabel,
  });
}

/**
 * The narrow form of {@link formatApplicationDuration}: "4h 58m" where the full form reads
 * "4 hrs 58 min". For surfaces too tight to spell the units out - the sidebar quota meter sits
 * beside its own label on one line - never for anything read aloud, where the full form is
 * clearer. Unit labels come from Intl rather than a hard-coded "h"/"m", so each locale gets
 * whatever CLDR calls narrow there - de "58 Min.", zh-TW "58 分鐘", and a plain "58m" for the
 * several locales (en, ja) whose narrow form really is the latin letter. The two halves are
 * joined by the same catalogue key as the full form, which carries the per-locale spacing.
 */
export function formatApplicationDurationCompact(
  milliseconds: number | null,
  locale: SupportedLocale,
  t: TFunction
): string {
  if (milliseconds === null || milliseconds <= 0) return '';

  const totalMinutes = Math.floor(milliseconds / 60_000);
  // No narrow form for this one: it is a sentence, not a number with a unit, and every catalogue
  // already keeps it short ("<1 min", "1分未満").
  if (totalMinutes < 1) return t('common.time.lessThanMinute');

  const narrow = (value: number, unit: 'hour' | 'minute') =>
    formatApplicationNumber(value, locale, { style: 'unit', unit, unitDisplay: 'narrow' });

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return narrow(minutes, 'minute');
  if (minutes === 0) return narrow(hours, 'hour');
  return t('common.time.durationHoursMinutes', {
    hours: narrow(hours, 'hour'),
    minutes: narrow(minutes, 'minute'),
  });
}

export function formatApplicationLastMet(
  iso: string | null,
  now: number,
  locale: SupportedLocale,
  t: TFunction
): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const days = Math.floor((now - then) / 86_400_000);
  if (days <= 0) return t('common.time.today');
  if (days === 1) return t('common.time.yesterday');
  if (days < 7) return t('common.time.daysAgo', { count: days });

  const [key, count] =
    days < 30
      ? (['weeksAgo', Math.floor(days / 7)] as const)
      : days < 365
        ? (['monthsAgo', Math.floor(days / 30)] as const)
        : (['yearsAgo', Math.floor(days / 365)] as const);
  return t(`common.time.${key}`, {
    count,
    value: formatApplicationNumber(count, locale),
  });
}
