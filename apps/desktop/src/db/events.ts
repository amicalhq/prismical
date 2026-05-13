import { asc, eq, gte, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import * as Y from "yjs";
import { db } from "./index";
import { saveYjsUpdate } from "./notes";
import {
  events,
  meetings,
  artifacts,
  notes,
  transcriptSegments,
  type NewEvent,
} from "./schema";
import { serializePlainTextToLexicalEditorStateJson } from "../services/notes/lexical-editor-state";

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
      // Seeded in the past so the attached completed meeting + transcript
      // + AI summary below tells a coherent story (no "upcoming" event with
      // an already-finished transcript).
      id: "customer-sync",
      title: "Customer Notes Workflow Sync",
      calendarColor: "#FF9F0A",
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/123",
      calendarEventUrl: "https://outlook.office365.com/calendar/item/ghi789",
      startAt: at(-2, 15, 0),
      endAt: at(-2, 15, 30),
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

  // Seed notes only on a truly empty DB (preserves existing behavior).
  const existingNotes = await db
    .select({ count: sql<number>`count(*)` })
    .from(notes);
  const notesAlreadySeeded = existingNotes[0].count > 0;

  const seedNotes: {
    title: string;
    eventId?: string;
    icon?: string;
    starred?: boolean;
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
      starred: true, // Surfaced in sidebar favorites so the end-to-end
      // demo (meeting + transcript + AI summary) is easy to find.
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
      daysAgo: 1,
    },
    {
      title: "Q3 roadmap priorities",
      icon: "🗺️",
      starred: true,
      daysAgo: 3,
    },
    {
      title: "Voice input edge cases",
      daysAgo: 2,
    },
    {
      title: "Release checklist v2.1",
      icon: "🚀",
      daysAgo: 4,
    },
    {
      title: "User interview notes — Sam",
      icon: "🎙️",
      daysAgo: 5,
    },
    {
      title: "Competitive analysis",
      daysAgo: 7,
    },
    {
      title: "Weekly reflection",
      icon: "📝",
      daysAgo: 6,
    },
  ];

  if (!notesAlreadySeeded) {
    for (const note of seedNotes) {
      const createdAt = new Date(now.getTime() - note.daysAgo * 86_400_000);
      await db.insert(notes).values({
        title: note.title,
        eventId: note.eventId ?? null,
        icon: note.icon ?? null,
        starred: note.starred ?? false,
        createdAt,
        updatedAt: createdAt,
      });
    }
  }

  // Idempotently seed the meeting + transcript + AI summary artifact attached
  // to the customer-sync note. Runs on both fresh DBs and existing dev DBs
  // that predate this seed, so the artifacts demo is always available.
  await seedCustomerSyncMeetingIfMissing(now);
}

// Look up the customer-sync note and, if it exists without a meeting, seed the
// completed-meeting + transcript + summary artifact. Idempotent.
async function seedCustomerSyncMeetingIfMissing(now: Date) {
  const [note] = await db
    .select({ id: notes.id })
    .from(notes)
    .where(eq(notes.eventId, "customer-sync"))
    .limit(1);
  if (!note) return;

  const [existing] = await db
    .select({ count: sql<number>`count(*)` })
    .from(meetings)
    .where(eq(meetings.noteId, note.id));
  if (existing.count > 0) return;

  await seedCustomerSyncMeeting(note.id, now);
}

// Seeds a completed meeting + transcript + AI summary artifact for the
// customer-sync note, so the dev DB has a realistic end-to-end example.
// Also seeds a few lines of raw notes on the note itself so the "Raw notes"
// tab shows the user's live jottings alongside the synthesized summary.
async function seedCustomerSyncMeeting(noteId: number, now: Date) {
  const meetingId = uuid();
  const startedAt = new Date(now.getTime() - 2 * 86_400_000); // 2 days ago
  const durationMs = 30 * 60_000;
  const endedAt = new Date(startedAt.getTime() + durationMs);

  const rawNotesText = [
    "Walk through onboarding notes use case during the call.",
    "Confirm the templates design review for end of the week.",
    "Open question — how to handle multiple contacts on one call?",
  ].join("\n");
  const rawNotesLexicalJson =
    serializePlainTextToLexicalEditorStateJson(rawNotesText);

  // `notes.content` is a fallback/snapshot field — the editor reads from Yjs
  // updates. Set both so list previews, search, and the live editor all show
  // something.
  await db
    .update(notes)
    .set({
      content: rawNotesLexicalJson,
      updatedAt: endedAt,
    })
    .where(eq(notes.id, noteId));

  // Seed a Yjs update so the Raw notes tab has content on first open.
  // The editor's YjsSyncPlugin stores the Lexical editor state JSON as a
  // plain string inside a Y.Text named "content".
  const ydoc = new Y.Doc();
  ydoc.getText("content").insert(0, rawNotesLexicalJson);
  await saveYjsUpdate(noteId, Y.encodeStateAsUpdate(ydoc));
  ydoc.destroy();

  await db.insert(meetings).values({
    id: meetingId,
    noteId,
    title: "Customer Notes Workflow Sync",
    startedAt,
    endedAt,
    durationMs,
    captureMode: "dual",
    state: "completed",
    transcriptionModel: "whisper-large-v3",
    createdAt: startedAt,
    updatedAt: endedAt,
  });

  const segmentDialogue: Array<{
    speaker: "you" | "them";
    text: string;
    startSec: number;
    endSec: number;
  }> = [
    {
      speaker: "you",
      text: "Thanks for making time. I wanted to walk through how we're planning to use the notes product during onboarding calls.",
      startSec: 2,
      endSec: 10,
    },
    {
      speaker: "them",
      text: "Sounds good. The customer success team has been asking for something like this — right now they're dumping everything into a shared doc and it gets messy fast.",
      startSec: 11,
      endSec: 22,
    },
    {
      speaker: "you",
      text: "Right. The idea is each onboarding call becomes a note, the transcript is captured, and the AI drafts a structured summary with decisions and action items.",
      startSec: 23,
      endSec: 37,
    },
    {
      speaker: "them",
      text: "Can we tailor the structure per playbook? Enterprise onboarding has different sections than SMB.",
      startSec: 38,
      endSec: 48,
    },
    {
      speaker: "you",
      text: "Yeah, that's where templates come in. We'll default new accounts to the onboarding playbook template but the team can switch.",
      startSec: 49,
      endSec: 62,
    },
    {
      speaker: "them",
      text: "And action items — can they route to the account owner automatically? Right now the CS team has to tag people manually.",
      startSec: 63,
      endSec: 75,
    },
    {
      speaker: "you",
      text: "Planning to auto-tag the account owner using the calendar event metadata. If there are multiple contacts on the call we'll probably need a disambiguation step.",
      startSec: 76,
      endSec: 91,
    },
    {
      speaker: "them",
      text: "Makes sense. Let's schedule a design review for the template picker — end of the week works.",
      startSec: 92,
      endSec: 104,
    },
  ];

  await db.insert(transcriptSegments).values(
    segmentDialogue.map((seg, index) => ({
      id: uuid(),
      meetingId,
      source: seg.speaker === "you" ? "mic" : "system",
      speaker: seg.speaker,
      text: seg.text,
      startTimeMs: seg.startSec * 1000,
      endTimeMs: seg.endSec * 1000,
      segmentOrder: index,
      isFinal: true,
      createdAt: startedAt,
    })),
  );

  const summaryText = [
    "Kicked off the Customer Notes Workflow Sync to align on how customer success will use in-product notes during onboarding calls.",
    "",
    "Key decisions",
    "",
    "New accounts default to the onboarding playbook template, with the ability to switch templates per call.",
    "Action items auto-tag the account owner using calendar event metadata.",
    "",
    "Action items",
    "",
    "Engineering to spec the account-owner lookup service by end of week.",
    "Product to draft the onboarding playbook template.",
    "Design review of the template picker UI scheduled for end of the week.",
    "",
    "Open questions",
    "",
    "How do we handle notes for accounts with multiple contacts on the call?",
    "Should the summary auto-regenerate when action items are edited in place?",
  ].join("\n");

  await db.insert(artifacts).values({
    id: uuid(),
    noteId,
    skillId: "summary",
    mode: "replace-doc",
    version: 1,
    content: serializePlainTextToLexicalEditorStateJson(summaryText),
    generator: "ai",
    modelId: "claude-opus-4-7",
    meta: { prompt: "default_summary_v1" },
    generatedAt: endedAt,
    createdAt: endedAt,
    updatedAt: endedAt,
  });
}
