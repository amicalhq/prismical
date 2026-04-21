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
