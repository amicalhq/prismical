import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
// Calendar-DAY logic + the shared clock-time formatter live in the data layer
// (see note below); imported here so getEventDateLabel can use eventDayKey,
// formatEventTimeRange can use formatTime12, and `@/lib/utils` keeps re-exporting them.
import { allDayStillCurrent, eventDayKey, formatTime12 } from "@prismical/app-client"
import {
  formatApplicationDateLabel,
  formatApplicationDuration,
  formatApplicationEventDateLabel,
  formatApplicationEventTimeRange,
  formatApplicationRelativeDay,
  formatApplicationTime,
  type ApplicationTFunction,
  type SupportedLocale,
} from "@prismical/app-i18n"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ─── Date / time formatting ─────────────────────────────────────────────────────
// Locale and translation input stay explicit. These compatibility names are re-exported by
// the web adapter, while the implementation lives in @prismical/app-i18n for both renderers.

export function formatDate(
  date: Date,
  referenceDate: Date,
  locale: SupportedLocale,
  t: ApplicationTFunction,
): string {
  return formatApplicationDateLabel(date, referenceDate, locale, t)
}

/**
 * The day something happened, relative to now: "Today" / "Yesterday" / "3 days
 * ago", falling back to an absolute date ("Jun 5") once "N days ago" stops
 * being easier to hold than the date itself. `now` is injectable for tests.
 */
export function formatRelativeDay(
  date: Date,
  now: Date,
  locale: SupportedLocale,
  t: ApplicationTFunction,
): string {
  return formatApplicationRelativeDay(date, now, locale, t)
}

export function formatTime24(date: Date, locale: SupportedLocale): string {
  return formatApplicationTime(date, locale)
}

/**
 * An elapsed span in plain English: "<1 min", "4 min", "1 hr 5 min", "2 hrs".
 * Empty string when the span is unknown (null) — callers drop the label rather
 * than print a zero they can't stand behind.
 */
export function formatDuration(
  ms: number | null,
  locale: SupportedLocale,
  t: ApplicationTFunction,
): string {
  return formatApplicationDuration(ms, locale, t)
}

/** "9:00 AM – 9:15 AM", or "All day" for all-day events. */
export function formatEventTimeRange(
  start: Date,
  end: Date,
  isAllDay = false,
  locale: SupportedLocale,
  t: ApplicationTFunction,
): string {
  return formatApplicationEventTimeRange(start, end, isAllDay, locale, t)
}

// All-day events are stored as UTC-midnight markers (Google's date-only
// values), so their calendar day must be read in UTC — reading it in the
// viewer's zone shifts the event to the previous day anywhere west of UTC.
// Timed events use the viewer's local zone as usual.

// `eventDayKey` + `allDayStillCurrent` (calendar-DAY logic driving the events
// data hook) and `formatTime12` (shared with the transcripts data hook) live in
// the data layer (@prismical/app-client) and are re-exported here so
// `@/lib/utils` consumers keep one source of truth.
export { allDayStillCurrent, eventDayKey, formatTime12 }

/** "Today" / "Tomorrow" / "Mon, Jun 9" — used as event-group day labels. */
export function getEventDateLabel(
  date: Date,
  isAllDay = false,
  referenceDate: Date,
  locale: SupportedLocale,
  t: ApplicationTFunction,
  options?: Intl.DateTimeFormatOptions,
): string {
  return formatApplicationEventDateLabel(
    date,
    isAllDay,
    referenceDate,
    locale,
    t,
    options,
  )
}
