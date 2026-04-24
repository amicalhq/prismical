function getLocale(): string | undefined {
  return typeof navigator !== "undefined" ? navigator.language : undefined;
}

export function formatEventTime(date: Date, locale = getLocale()): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatEventTimeRange(
  startAt: Date,
  endAt: Date,
  isAllDay: boolean,
  locale = getLocale(),
): string {
  if (isAllDay) return "All day";
  return `${formatEventTime(startAt, locale)} - ${formatEventTime(endAt, locale)}`;
}

// Returns "Today" / "Tomorrow" for near dates, otherwise a localized
// date string formatted via `dateStyle` (callers pass their preferred
// DateTimeFormatOptions). Used by upcoming-events lists and the note
// header event tooltip so labels stay consistent across surfaces.
export function getEventDateLabel(
  date: Date,
  t: (key: string) => string,
  dateStyle: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" },
  locale = getLocale(),
): string {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfDate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  const diffDays = Math.round(
    (startOfDate.getTime() - startOfToday.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (diffDays === 0) return t("settings.home.upcoming.today");
  if (diffDays === 1) return t("settings.home.upcoming.tomorrow");

  return new Intl.DateTimeFormat(locale, dateStyle).format(date);
}
