import type { ApplicationTFunction, SupportedLocale } from '@prismical/app-i18n';

/**
 * Date bucketing for a note list.
 *
 * The buckets NEST and never CROSS: today is inside this month, which is inside this year, so a
 * note always belongs to the most specific bucket and every heading is literally true of what sits
 * under it. That is what rules out the rolling windows Apple uses ("Previous 30 days"), which cross
 * the month boundary — under them, "August" heads a partial August while the rest of August sits
 * somewhere that isn't a calendar unit at all.
 *
 *   Today · Yesterday · Earlier this month · August · July · 2025 · 2024
 *
 * The cost is recency resolution early in a month: on the 3rd, a note from five days ago is already
 * filed under last month's name. That is the deliberate trade for headings that never lie.
 */

export interface NoteDateGroup<T> {
  /** Stable across renders; the label is localized and changes with the interface language. */
  key: string;
  label: string;
  notes: T[];
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The bucket a date belongs to, as a stable key plus its heading. */
function bucketOf(
  date: Date,
  now: Date,
  locale: SupportedLocale,
  t: ApplicationTFunction
): { key: string; label: string } {
  const day = startOfDay(date);
  const today = startOfDay(now);
  // Yesterday by the CALENDAR, not by subtracting 24h: the day after a fall-back transition is 25
  // hours long, so `today - 86_400_000` lands an hour past yesterday's midnight and everything
  // touched that day falls through to the month bucket instead.
  const yesterday = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  // A note saved a moment in the future (clock skew) belongs at the top, not under a month heading
  // ahead of today.
  if (day >= today) return { key: 'today', label: t('notes.list.today') };
  if (day >= yesterday) return { key: 'yesterday', label: t('common.time.yesterday') };
  if (date.getFullYear() === now.getFullYear()) {
    if (date.getMonth() === now.getMonth()) {
      return { key: 'this-month', label: t('notes.list.earlierThisMonth') };
    }
    return {
      key: `month-${date.getMonth()}`,
      label: new Intl.DateTimeFormat(locale, { month: 'long' }).format(date),
    };
  }
  return {
    key: `year-${date.getFullYear()}`,
    // Formatted, not String(year): ja and zh-TW write a year with a suffix.
    label: new Intl.DateTimeFormat(locale, { year: 'numeric' }).format(date),
  };
}

/**
 * Group an ALREADY SORTED list into date buckets, emitting a new group each time the bucket
 * changes. Walking the given order rather than bucketing and re-sorting means the groups follow
 * whatever order the caller sorted by — oldest-first included — with no second opinion about it.
 */
export function groupNotesByDate<T>(
  notes: T[],
  dateOf: (note: T) => Date,
  now: Date,
  locale: SupportedLocale,
  t: ApplicationTFunction
): NoteDateGroup<T>[] {
  const groups: NoteDateGroup<T>[] = [];
  for (const note of notes) {
    const bucket = bucketOf(dateOf(note), now, locale, t);
    const open = groups[groups.length - 1];
    if (open && open.key === bucket.key) open.notes.push(note);
    else groups.push({ ...bucket, notes: [note] });
  }
  return groups;
}
