import { asc, eq, gte, sql } from "drizzle-orm";
import { db } from "./index";
import { events, notes, type NewEvent } from "./schema";

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

// Seed dummy events and a few linked notes (idempotent — skips existing rows)
export async function seedEventsAndNotes() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const at = (daysFromToday: number, hour: number, minute: number) =>
    new Date(
      today.getTime() + daysFromToday * 86_400_000 + (hour * 60 + minute) * 60_000,
    );

  const seedEvents: Omit<NewEvent, "createdAt" | "updatedAt">[] = [
    {
      id: "standup",
      title: "Product & Engineering Daily Standup",
      calendarColor: "#34C759",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      calendarEventUrl: "https://calendar.google.com/calendar/event?eid=abc123",
      startAt: at(0, 9, 30),
      endAt: at(0, 10, 0),
    },
    {
      id: "1on1",
      title: "1:1 with Manager",
      calendarColor: "#34C759",
      meetingUrl: "https://meet.google.com/xyz-uvwx-yz",
      calendarEventUrl: "https://calendar.google.com/calendar/event?eid=xyz789",
      startAt: at(0, 14, 0),
      endAt: at(0, 14, 30),
    },
    {
      id: "design-review",
      title: "Desktop Home Experience Design Review",
      calendarColor: "#0A84FF",
      meetingUrl: "https://zoom.us/j/123456789",
      calendarEventUrl: "https://calendar.google.com/calendar/event?eid=def456",
      startAt: at(1, 11, 0),
      endAt: at(1, 11, 45),
    },
    {
      id: "customer-sync",
      title: "Customer Notes Workflow Sync",
      calendarColor: "#FF9F0A",
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/123",
      calendarEventUrl: "https://outlook.office365.com/calendar/item/ghi789",
      startAt: at(2, 15, 0),
      endAt: at(2, 15, 30),
    },
    {
      id: "sprint-planning",
      title: "Sprint Planning",
      calendarColor: "#0A84FF",
      meetingUrl: "https://meet.google.com/spr-plan-ing",
      calendarEventUrl: "https://calendar.google.com/calendar/event?eid=spr123",
      startAt: at(3, 10, 0),
      endAt: at(3, 11, 0),
    },
    {
      id: "all-hands",
      title: "Company All-Hands",
      calendarColor: "#AF52DE",
      meetingUrl: "https://zoom.us/j/987654321",
      calendarEventUrl: "https://calendar.google.com/calendar/event?eid=ah456",
      startAt: at(5, 16, 0),
      endAt: at(5, 17, 0),
    },
    {
      id: "eng-town-hall",
      title: "Engineering Town Hall",
      calendarColor: "#0A84FF",
      meetingUrl: "https://meet.google.com/eng-town-hall",
      calendarEventUrl: "https://calendar.google.com/calendar/event?eid=eth001",
      startAt: at(7, 11, 0),
      endAt: at(7, 12, 0),
    },
    {
      id: "q-roadmap-review",
      title: "Quarterly Roadmap Review",
      calendarColor: "#5856D6",
      meetingUrl: "https://zoom.us/j/444555666",
      calendarEventUrl: "https://calendar.google.com/calendar/event?eid=qrr001",
      startAt: at(7, 14, 0),
      endAt: at(7, 15, 30),
    },
    {
      id: "coffee-pm",
      title: "Coffee chat with PM",
      calendarColor: "#34C759",
      meetingUrl: "https://meet.google.com/coffee-pm",
      calendarEventUrl: "https://calendar.google.com/calendar/event?eid=cpm001",
      startAt: at(8, 10, 0),
      endAt: at(8, 10, 30),
    },
    {
      id: "customer-onboarding",
      title: "Customer Onboarding Session",
      calendarColor: "#FF9F0A",
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/onboarding",
      calendarEventUrl: "https://outlook.office365.com/calendar/item/co001",
      startAt: at(10, 9, 0),
      endAt: at(10, 10, 0),
    },
    {
      id: "marketing-sync",
      title: "Marketing Sync",
      calendarColor: "#AF52DE",
      meetingUrl: "https://meet.google.com/marketing-sync",
      calendarEventUrl: "https://calendar.google.com/calendar/event?eid=mks001",
      startAt: at(10, 13, 30),
      endAt: at(10, 14, 30),
    },
    {
      id: "1on1-week2",
      title: "1:1 with Manager",
      calendarColor: "#34C759",
      meetingUrl: "https://meet.google.com/xyz-uvwx-yz",
      calendarEventUrl: "https://calendar.google.com/calendar/event?eid=1on1w2",
      startAt: at(11, 14, 0),
      endAt: at(11, 14, 30),
    },
    {
      id: "sprint-planning-2",
      title: "Sprint Planning",
      calendarColor: "#0A84FF",
      meetingUrl: "https://meet.google.com/spr-plan-ing",
      calendarEventUrl: "https://calendar.google.com/calendar/event?eid=spr222",
      startAt: at(13, 10, 0),
      endAt: at(13, 11, 0),
    },
    {
      id: "standup-week2",
      title: "Product & Engineering Daily Standup",
      calendarColor: "#34C759",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      calendarEventUrl: "https://calendar.google.com/calendar/event?eid=stnw2",
      startAt: at(14, 9, 30),
      endAt: at(14, 10, 0),
    },
    {
      id: "product-retro",
      title: "Product Retrospective",
      calendarColor: "#FF9F0A",
      meetingUrl: "https://zoom.us/j/777888999",
      calendarEventUrl: "https://calendar.google.com/calendar/event?eid=ret001",
      startAt: at(17, 15, 0),
      endAt: at(17, 16, 0),
    },
    {
      id: "board-meeting",
      title: "Board Meeting",
      calendarColor: "#FF3B30",
      meetingUrl: "https://zoom.us/j/111222333",
      calendarEventUrl: "https://calendar.google.com/calendar/event?eid=bd001",
      startAt: at(21, 16, 0),
      endAt: at(21, 17, 30),
    },
  ];

  // Seed events (insert or ignore)
  for (const event of seedEvents) {
    await db
      .insert(events)
      .values({ ...event, createdAt: now, updatedAt: now })
      .onConflictDoNothing();
  }

  // Seed notes (only if no notes exist yet)
  const existingNotes = await db
    .select({ count: sql<number>`count(*)` })
    .from(notes);
  if (existingNotes[0].count > 0) return;

  const seedNotes: {
    title: string;
    eventId?: string;
    icon?: string;
    starred?: boolean;
    folder?: string;
    daysAgo: number;
  }[] = [
    // Event-linked notes
    {
      title: "Product & Engineering Daily Standup",
      eventId: "standup",
      daysAgo: 0,
    },
    {
      title: "Desktop Home Experience Design Review",
      eventId: "design-review",
      daysAgo: 1,
    },
    {
      title: "Customer Notes Workflow Sync",
      eventId: "customer-sync",
      daysAgo: 2,
    },
    // Standalone notes
    {
      title: "App architecture brainstorm",
      icon: "🏗️",
      starred: true,
      daysAgo: 0,
    },
    {
      title: "Onboarding flow copy",
      icon: "✍️",
      folder: "Product",
      daysAgo: 1,
    },
    {
      title: "Q3 roadmap priorities",
      icon: "🗺️",
      starred: true,
      folder: "Product",
      daysAgo: 3,
    },
    {
      title: "Voice input edge cases",
      folder: "Engineering",
      daysAgo: 2,
    },
    {
      title: "Release checklist v2.1",
      icon: "🚀",
      folder: "Engineering",
      daysAgo: 4,
    },
    {
      title: "User interview notes — Sam",
      icon: "🎙️",
      folder: "Research",
      daysAgo: 5,
    },
    {
      title: "Competitive analysis",
      folder: "Research",
      daysAgo: 7,
    },
    {
      title: "Weekly reflection",
      icon: "📝",
      daysAgo: 6,
    },
  ];

  for (const note of seedNotes) {
    const createdAt = new Date(now.getTime() - note.daysAgo * 86_400_000);
    await db.insert(notes).values({
      title: note.title,
      eventId: note.eventId ?? null,
      icon: note.icon ?? null,
      starred: note.starred ?? false,
      folder: note.folder ?? null,
      createdAt,
      updatedAt: createdAt,
    });
  }
}
