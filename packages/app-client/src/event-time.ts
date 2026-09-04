// Date/time helpers the data layer needs. The calendar-day
// functions drive the events data hook (api/hooks/events.ts); formatTime12 anchors
// the transcripts hook's wall-clock labels (segmentClockLabel). They live here — not
// in @prismical/app-ui — because app-ui imports from this package (the reverse would
// be circular); app-ui re-exports them for its display helpers. Other DISPLAY date
// helpers (formatDate, getEventDateLabel, …) stay in @prismical/app-ui.
//
// All-day events are stored as UTC-midnight markers (Google's date-only
// values), so their calendar day must be read in UTC — reading it in the
// viewer's zone shifts the event to the previous day anywhere west of UTC.
// Timed events use the viewer's local zone as usual.

/** Comparable/sortable yyyymmdd key for the calendar day an event falls on. */
export function eventDayKey(date: Date, isAllDay = false): number {
  return isAllDay
    ? date.getUTCFullYear() * 10_000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate()
    : date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/**
 * True while an all-day event still has a current/future day. `end` is
 * Google's EXCLUSIVE next-day marker; when an event has no real end, callers
 * fall back to `start`, which the second clause covers.
 */
export function allDayStillCurrent(start: Date, end: Date, today: Date = new Date()): boolean {
  const todayKey = eventDayKey(today);
  return eventDayKey(end, true) > todayKey || eventDayKey(start, true) >= todayKey;
}

/** Locale-appropriate clock time in the viewer's zone. Shared by the transcripts
 * data hook (segmentClockLabel) and app-ui's display helpers (re-exported there).
 * The historical name is retained for API compatibility; English remains the default. */
export function formatTime12(date: Date, locale = 'en-US'): string {
  return date
    .toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
    })
    .replace(/\s/g, ' ');
}
