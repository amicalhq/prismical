import { asc, eq, gte } from "drizzle-orm";
import { db } from "./index";
import { events, type NewEvent } from "./schema";

export async function upsertEvent(
  data: Omit<NewEvent, "createdAt" | "updatedAt">,
) {
  const now = new Date();

  await db
    .insert(events)
    .values({
      ...data,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: events.id,
      set: {
        title: data.title,
        calendarColor: data.calendarColor,
        meetingUrl: data.meetingUrl,
        calendarEventUrl: data.calendarEventUrl,
        startAt: data.startAt,
        endAt: data.endAt,
        isAllDay: data.isAllDay,
        updatedAt: now,
      },
    });
}

export async function getEventById(id: string) {
  const result = await db.select().from(events).where(eq(events.id, id));
  return result[0] || null;
}

export async function getUpcomingEvents(limit?: number) {
  const now = new Date();

  const base = db
    .select()
    .from(events)
    .where(gte(events.endAt, now))
    .orderBy(asc(events.startAt));

  return limit !== undefined ? await base.limit(limit) : await base;
}
