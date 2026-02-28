import { eq, sql } from "drizzle-orm";
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
        startTime: data.startTime,
        endTime: data.endTime,
        date: data.date,
        updatedAt: now,
      },
    });
}

export async function getEventById(id: string) {
  const result = await db.select().from(events).where(eq(events.id, id));
  return result[0] || null;
}

// Seed dummy events and a few linked notes (idempotent — skips existing rows)
export async function seedEventsAndNotes() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const dayAfter = new Date(today.getTime() + 2 * 86_400_000);

  const seedEvents: Omit<NewEvent, "createdAt" | "updatedAt">[] = [
    {
      id: "standup",
      title: "Product & Engineering Daily Standup",
      calendarColor: "#34C759",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      calendarEventUrl:
        "https://calendar.google.com/calendar/event?eid=abc123",
      startTime: "9:30 AM",
      endTime: "10:00 AM",
      date: today.toISOString(),
    },
    {
      id: "1on1",
      title: "1:1 with Manager",
      calendarColor: "#34C759",
      meetingUrl: "https://meet.google.com/xyz-uvwx-yz",
      calendarEventUrl:
        "https://calendar.google.com/calendar/event?eid=xyz789",
      startTime: "2:00 PM",
      endTime: "2:30 PM",
      date: today.toISOString(),
    },
    {
      id: "design-review",
      title: "Desktop Home Experience Design Review",
      calendarColor: "#0A84FF",
      meetingUrl: "https://zoom.us/j/123456789",
      calendarEventUrl:
        "https://calendar.google.com/calendar/event?eid=def456",
      startTime: "11:00 AM",
      endTime: "11:45 AM",
      date: tomorrow.toISOString(),
    },
    {
      id: "customer-sync",
      title: "Customer Notes Workflow Sync",
      calendarColor: "#FF9F0A",
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/123",
      calendarEventUrl:
        "https://outlook.office365.com/calendar/item/ghi789",
      startTime: "3:00 PM",
      endTime: "3:30 PM",
      date: dayAfter.toISOString(),
    },
    {
      id: "sprint-planning",
      title: "Sprint Planning",
      calendarColor: "#0A84FF",
      meetingUrl: "https://meet.google.com/spr-plan-ing",
      calendarEventUrl:
        "https://calendar.google.com/calendar/event?eid=spr123",
      startTime: "10:00 AM",
      endTime: "11:00 AM",
      date: new Date(today.getTime() + 3 * 86_400_000).toISOString(),
    },
    {
      id: "all-hands",
      title: "Company All-Hands",
      calendarColor: "#AF52DE",
      meetingUrl: "https://zoom.us/j/987654321",
      calendarEventUrl:
        "https://calendar.google.com/calendar/event?eid=ah456",
      startTime: "4:00 PM",
      endTime: "5:00 PM",
      date: new Date(today.getTime() + 5 * 86_400_000).toISOString(),
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
