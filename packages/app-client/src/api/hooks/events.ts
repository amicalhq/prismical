"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UpdateCalendarResponseSchema } from "@prismical/api-contracts/apps/v1";
import { apiClient, ME_PREFIX } from "../client";
import { toCalendarEvent, type CoreCalendar, type CoreEvent } from "../adapters";
import type { CalendarEvent, UpcomingMeeting } from "@prismical/app-contracts";
import { allDayStillCurrent } from "../../event-time";

export const calendarsKey = ["calendars"] as const;
export const eventsKey = ["events"] as const;

export function useCalendars() {
  return useQuery<CoreCalendar[]>({
    queryKey: calendarsKey,
    queryFn: () => apiClient.list<CoreCalendar>(`${ME_PREFIX}/calendars`),
  });
}

/**
 * Toggle whether one calendar of a connected account syncs its events.
 * Optimistic: the checkbox flips immediately and rolls back on error. Disabling server-side
 * tombstones that calendar's events, enabling re-syncs them — so refresh events on settle.
 */
export function useSetCalendarEnabled() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.calendarUpdate" },
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) =>
      UpdateCalendarResponseSchema.parse(
        await apiClient.patchRaw<unknown>(`${ME_PREFIX}/calendars/${id}`, { enabled }),
      ),
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: calendarsKey });
      const prev = qc.getQueryData<CoreCalendar[]>(calendarsKey);
      qc.setQueryData<CoreCalendar[]>(calendarsKey, (old) =>
        (old ?? []).map((c) => (c.id === id ? { ...c, enabled } : c)),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(calendarsKey, ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: calendarsKey });
      void qc.invalidateQueries({ queryKey: eventsKey });
    },
  });
}

/** Live events mapped to the UI shape, colored via their calendar, sorted by start. */
export function useCalendarEvents() {
  const calendars = useCalendars();
  const events = useQuery<CoreEvent[]>({
    queryKey: eventsKey,
    queryFn: () => apiClient.list<CoreEvent>(`${ME_PREFIX}/events`),
  });

  const data = React.useMemo(() => {
    if (!events.data) return undefined;
    const colorByCalendar = new Map((calendars.data ?? []).map((c) => [c.id, c.color] as const));
    return events.data
      .filter((e) => e.status !== "cancelled")
      .map((e) => toCalendarEvent(e, colorByCalendar.get(e.calendarId)))
      .filter((e): e is CalendarEvent => e !== null)
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  }, [events.data, calendars.data]);

  return { ...events, data };
}

/** Look up a single event (e.g. a note's linked event) from the live list. */
export function useEvent(id: string | undefined): CalendarEvent | undefined {
  const { data } = useCalendarEvents();
  return id ? data?.find((e) => e.id === id) : undefined;
}

/** Not-yet-ended events as Home's UpcomingMeeting shape, soonest first. */
export function useUpcomingMeetings(limit?: number): UpcomingMeeting[] {
  const { data } = useCalendarEvents();
  return React.useMemo(() => {
    const now = Date.now();
    const mapped = (data ?? [])
      // All-day events stay "upcoming" through their whole (UTC-keyed) last
      // day — their exclusive UTC-midnight end would otherwise drop them
      // mid-afternoon anywhere west of UTC.
      .filter((e) =>
        e.isAllDay
          ? allDayStillCurrent(new Date(e.start), new Date(e.end))
          : new Date(e.end).getTime() >= now,
      )
      .map<UpcomingMeeting>((e) => ({
        id: e.id,
        calendarColor: e.calendarColor,
        startAt: new Date(e.start),
        endAt: new Date(e.end),
        isAllDay: Boolean(e.isAllDay),
        title: e.title,
        meetingUrl: e.joinUrl ?? null,
        calendarEventUrl: e.joinUrl ?? null,
      }));
    return typeof limit === "number" ? mapped.slice(0, limit) : mapped;
  }, [data, limit]);
}
