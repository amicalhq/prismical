// Dev-only seed fixtures. Runs at app start when !app.isPackaged (gated at
// the call site in app-manager.ts — bare isPackaged, not NODE_ENV, so a
// packaged binary can never seed Emma into a real user's DB even if
// NODE_ENV is set in the launching shell). Idempotent at the row level:
// re-launching never duplicates content; once a dev edits anything, the seed
// stops adding new fixtures to that table. The full demo only materialises
// on a truly empty database — `rm prismical.db && pnpm dev`.
//
// Splits cleanly into 8 phases (see seedDevFixtures below). Each phase is
// gated independently so partial-state DBs (older dev DBs that predate
// newer entities like folders / tags / snapshots) still get the additive
// rows on next launch.

import { eq, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "../db";
import {
  artifacts,
  events,
  meetings,
  noteSnapshots,
  notes,
  transcriptions,
  transcriptSegments,
  type NewEvent,
} from "../db/schema";
import {
  createFolder,
  getFolderByNameAndParent,
} from "../db/folders";
import { attachTag, createTag, getTagByName } from "../db/tags";
import { saveNoteSnapshot, saveYjsUpdate } from "../db/notes";
import { createTranscription } from "../db/transcriptions";
import { logger } from "../main/logger";
import { markdownToYDocUpdate } from "./notes/markdown-to-ydoc";
import { serializePlainTextToTiptapJson } from "./notes/tiptap-editor-state";

const DAY_MS = 86_400_000;

export async function seedDevFixtures(): Promise<void> {
  const now = new Date();

  const folderIdByName = await seedFolders();
  const tagIdByName = await seedTags();
  await seedEvents(now);
  const noteIdsByKey = await seedNotesIfEmpty(now, folderIdByName, tagIdByName);
  await seedCatchUpMeetingIfMissing(now, noteIdsByKey);
  await seedVoiceMemoMeetingIfMissing(now, noteIdsByKey);
  await seedQ3SnapshotsIfMissing(noteIdsByKey);
  await seedTranscriptionsIfEmpty(now);

  logger.main.info("Seeded dev fixtures (idempotent)");
}

// ---------------------------------------------------------------------------
// 1. Folders
// ---------------------------------------------------------------------------

const FOLDER_NAMES = ["Personal", "Family", "Eng Team", "Sales Team"] as const;
type FolderName = (typeof FOLDER_NAMES)[number];

async function seedFolders(): Promise<Map<FolderName, number>> {
  const byName = new Map<FolderName, number>();
  for (const name of FOLDER_NAMES) {
    const existing = await getFolderByNameAndParent(db, name, null);
    if (existing) {
      byName.set(name, existing.id);
      continue;
    }
    const row = await createFolder(db, { name, parentId: null });
    byName.set(name, row.id);
  }
  return byName;
}

// ---------------------------------------------------------------------------
// 2. Tags
// ---------------------------------------------------------------------------

const TAG_SEEDS = [
  { name: "roadmap", color: "#0A84FF", isFavorite: false },
  { name: "engineering", color: "#34C759", isFavorite: false },
  { name: "design", color: "#AF52DE", isFavorite: false },
  { name: "customer", color: "#FF9F0A", isFavorite: false },
  { name: "weekly", color: "#5856D6", isFavorite: false },
] as const;
type TagName = (typeof TAG_SEEDS)[number]["name"];

async function seedTags(): Promise<Map<TagName, number>> {
  const byName = new Map<TagName, number>();
  for (const t of TAG_SEEDS) {
    const existing = await getTagByName(db, t.name);
    if (existing) {
      byName.set(t.name, existing.id);
      continue;
    }
    const row = await createTag(db, {
      name: t.name,
      color: t.color,
      isFavorite: t.isFavorite,
    });
    byName.set(t.name, row.id);
  }
  return byName;
}

// ---------------------------------------------------------------------------
// 3. Events
// ---------------------------------------------------------------------------

async function seedEvents(now: Date): Promise<void> {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const at = (daysFromToday: number, hour: number, minute: number) =>
    new Date(
      today.getTime() + daysFromToday * DAY_MS + (hour * 60 + minute) * 60_000,
    );

  const eventRows: Omit<NewEvent, "createdAt" | "updatedAt">[] = [
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
      // Seeded in the past so the attached completed meeting + transcript +
      // AI summary below tells a coherent story. Event id stays "customer-sync"
      // (internal) even though the title is now "Catch-up with Emma" — the
      // catch-up-meeting seeder looks the note up via this event id.
      id: "customer-sync",
      title: "Catch-up with Emma",
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

  for (const event of eventRows) {
    await db
      .insert(events)
      .values({ ...event, createdAt: now, updatedAt: now })
      .onConflictDoNothing();
  }
}

// ---------------------------------------------------------------------------
// 4. Notes (+ content + Yjs + folder filing + tags)
// ---------------------------------------------------------------------------

type NoteKey =
  | "standup"
  | "design-review"
  | "catch-up-emma"
  | "app-architecture"
  | "onboarding-copy"
  | "q3-roadmap"
  | "voice-input-edge-cases"
  | "release-checklist"
  | "user-interview-sam"
  | "competitive-analysis"
  | "weekly-reflection"
  | "acme-discovery"
  | "riverstone-renewal"
  | "france-trip"
  | "voice-memo-tuesday"
  | "lecture-llms";

interface NoteSpec {
  key: NoteKey;
  title: string;
  icon?: string;
  starred?: boolean;
  eventId?: string;
  daysAgo: number;
  folder?: FolderName;
  tags?: TagName[];
  markdown: string;
}

async function seedNotesIfEmpty(
  now: Date,
  folderIdByName: Map<FolderName, number>,
  tagIdByName: Map<TagName, number>,
): Promise<Map<NoteKey, number>> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(notes);
  if (count > 0) {
    // DB already has notes (user-created or a previous seed). Skip every
    // note-dependent step. Best-effort lookup of the catch-up note by event
    // id is still useful for the meeting-seed phase below — that note is
    // the one seed addition that's keyed off a stable event id, so it can
    // re-seed its meeting/transcript/artifact onto a partial-state DB.
    // Newer note-keyed additions (voice-memo, q3-roadmap snapshots) only
    // light up on a fresh DB; `rm prismical.db && pnpm dev` is the path
    // back to the full demo.
    const byKey = new Map<NoteKey, number>();
    const [catchUp] = await db
      .select({ id: notes.id })
      .from(notes)
      .where(eq(notes.eventId, "customer-sync"))
      .limit(1);
    if (catchUp) byKey.set("catch-up-emma", catchUp.id);
    return byKey;
  }

  const specs = NOTE_SPECS();
  const byKey = new Map<NoteKey, number>();

  for (const spec of specs) {
    const createdAt = new Date(now.getTime() - spec.daysAgo * DAY_MS);
    const folderId = spec.folder ? folderIdByName.get(spec.folder) ?? null : null;
    const [row] = await db
      .insert(notes)
      .values({
        title: spec.title,
        eventId: spec.eventId ?? null,
        icon: spec.icon ?? null,
        starred: spec.starred ?? false,
        folderId,
        content: spec.markdown,
        createdAt,
        updatedAt: createdAt,
      })
      .returning({ id: notes.id });
    byKey.set(spec.key, row.id);

    // Encode the markdown into a Yjs XmlFragment so the editor opens with
    // content on first mount.
    const encoded = markdownToYDocUpdate(spec.markdown);
    await saveYjsUpdate(db, row.id, encoded);

    // Attach tags.
    if (spec.tags) {
      for (const tagName of spec.tags) {
        const tagId = tagIdByName.get(tagName);
        if (tagId === undefined) continue;
        await attachTag(db, row.id, tagId);
      }
    }
  }

  return byKey;
}

// ---------------------------------------------------------------------------
// 5. Catch-up with Emma — multi-speaker meeting demo
// ---------------------------------------------------------------------------

async function seedCatchUpMeetingIfMissing(
  now: Date,
  noteIdsByKey: Map<NoteKey, number>,
): Promise<void> {
  const noteId = noteIdsByKey.get("catch-up-emma");
  if (noteId === undefined) return;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(meetings)
    .where(eq(meetings.noteId, noteId));
  if (count > 0) return;

  const meetingId = uuid();
  const startedAt = new Date(now.getTime() - 2 * DAY_MS);
  const durationMs = 30 * 60_000;
  const endedAt = new Date(startedAt.getTime() + durationMs);

  await db.insert(meetings).values({
    id: meetingId,
    noteId,
    title: "Catch-up with Emma",
    startedAt,
    endedAt,
    durationMs,
    captureMode: "dual",
    state: "completed",
    transcriptionModel: "whisper-large-v3",
    createdAt: startedAt,
    updatedAt: endedAt,
  });

  const dialogue: Array<{
    speaker: "you" | "them";
    text: string;
    startSec: number;
    endSec: number;
  }> = [
    {
      speaker: "you",
      text: "Thanks for grabbing 30 minutes. Wanted to align on where we're landing for the homepage redesign before the review tomorrow.",
      startSec: 2,
      endSec: 12,
    },
    {
      speaker: "them",
      text: "Good timing. I had a couple of things I wanted to bounce off you anyway. Where are you on the priority list?",
      startSec: 13,
      endSec: 22,
    },
    {
      speaker: "you",
      text: "Hero section stays. I think we drop the testimonials carousel though — the funnel data isn't backing it up.",
      startSec: 23,
      endSec: 35,
    },
    {
      speaker: "them",
      text: "Agreed. Product won't love it, but the numbers speak for themselves. What about social proof in general — do we just lose it?",
      startSec: 36,
      endSec: 48,
    },
    {
      speaker: "you",
      text: "I was thinking we move it to a single trust bar — logos plus one quote. Lighter, less visually noisy.",
      startSec: 49,
      endSec: 60,
    },
    {
      speaker: "them",
      text: "I can mock that. While we're at it — the CTA copy. 'Get started' is generic. Worth A/B testing something like 'Start free'?",
      startSec: 61,
      endSec: 75,
    },
    {
      speaker: "you",
      text: "Let's run an A/B on the headline and CTA together. I'll write the variants doc and loop in marketing.",
      startSec: 76,
      endSec: 88,
    },
    {
      speaker: "them",
      text: "Perfect. One thing I'm still on the fence about — keep the demo video below the fold, or swap it for a video link? It's eating half a section.",
      startSec: 89,
      endSec: 104,
    },
  ];

  await db.insert(transcriptSegments).values(
    dialogue.map((seg, index) => ({
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

  const summary = [
    "Aligned on homepage redesign priorities ahead of tomorrow's design review.",
    "",
    "Summary",
    "",
    "Dropping the testimonials carousel — funnel data doesn't support it.",
    "Replacing it with a single trust bar (logos plus one quote).",
    "Running an A/B test on the hero headline and CTA copy together.",
    "",
    "Action items",
    "",
    "Draft the A/B test doc covering the headline + CTA variants; loop in marketing on copy.",
    "Emma to mock the trust bar replacement and the lighter social-proof layout.",
    "",
    "Open questions",
    "",
    "Keep the demo video below the fold, or swap to a video link to recover the half-section it eats up?",
  ].join("\n");

  await db.insert(artifacts).values({
    id: uuid(),
    noteId,
    skillId: "enhance",
    mode: "replace-doc",
    version: 1,
    content: serializePlainTextToTiptapJson(summary),
    generator: "ai",
    modelId: "claude-opus-4-7",
    meta: { prompt: "default_summary_v1" },
    generatedAt: endedAt,
    createdAt: endedAt,
    updatedAt: endedAt,
  });
}

// ---------------------------------------------------------------------------
// 6. Voice memo — single-speaker meeting demo
// ---------------------------------------------------------------------------

async function seedVoiceMemoMeetingIfMissing(
  now: Date,
  noteIdsByKey: Map<NoteKey, number>,
): Promise<void> {
  const noteId = noteIdsByKey.get("voice-memo-tuesday");
  if (noteId === undefined) return;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(meetings)
    .where(eq(meetings.noteId, noteId));
  if (count > 0) return;

  const meetingId = uuid();
  const startedAt = new Date(now.getTime() - 1 * DAY_MS);
  const durationMs = 5 * 60_000;
  const endedAt = new Date(startedAt.getTime() + durationMs);

  await db.insert(meetings).values({
    id: meetingId,
    noteId,
    title: "Voice memo — Tuesday morning",
    startedAt,
    endedAt,
    durationMs,
    captureMode: "mic",
    state: "completed",
    transcriptionModel: "whisper-large-v3",
    createdAt: startedAt,
    updatedAt: endedAt,
  });

  const lines: Array<{ text: string; startSec: number; endSec: number }> = [
    {
      text: "Okay, recording a quick voice memo. Two things on my mind from this morning's standup.",
      startSec: 2,
      endSec: 10,
    },
    {
      text: "First — we keep punting the onboarding docs cleanup. Every time a new person joins they hit the same gaps. Feels small per incident, costs us hours over a quarter. Worth picking up this sprint.",
      startSec: 11,
      endSec: 30,
    },
    {
      text: "Second — the meetings UI gets sluggish when there's a long transcript open. Haven't profiled it but it feels like the segments are re-rendering on every keystroke. Should flag it before the next demo.",
      startSec: 31,
      endSec: 52,
    },
    {
      text: "Action items for me: write the doc fixes today, and file a bug on the meetings UI thing so it doesn't get lost.",
      startSec: 53,
      endSec: 65,
    },
  ];

  await db.insert(transcriptSegments).values(
    lines.map((seg, index) => ({
      id: uuid(),
      meetingId,
      source: "mic",
      speaker: "you",
      text: seg.text,
      startTimeMs: seg.startSec * 1000,
      endTimeMs: seg.endSec * 1000,
      segmentOrder: index,
      isFinal: true,
      createdAt: startedAt,
    })),
  );

  const summary = [
    "Key points",
    "",
    "Onboarding docs keep tripping up new joiners — small per incident, large in aggregate.",
    "Meetings UI feels slow when a long transcript is open; suspect re-render thrash on keystroke.",
    "",
    "Action items",
    "",
    "Write the onboarding doc fixes today.",
    "File a bug on the meetings UI re-render suspicion so it doesn't get lost before the next demo.",
  ].join("\n");

  await db.insert(artifacts).values({
    id: uuid(),
    noteId,
    skillId: "enhance",
    mode: "replace-doc",
    version: 1,
    content: serializePlainTextToTiptapJson(summary),
    generator: "ai",
    modelId: "claude-opus-4-7",
    meta: { prompt: "default_summary_v1" },
    generatedAt: endedAt,
    createdAt: endedAt,
    updatedAt: endedAt,
  });
}

// ---------------------------------------------------------------------------
// 7. Note snapshots — two snapshots on the Q3 roadmap note
// ---------------------------------------------------------------------------

const Q3_SNAPSHOT_V1_DRAFT_MARKDOWN = `# Q3 roadmap priorities

## Themes

- Meeting capture quality is the foundation
- Notes UX needs polish
- Templates are the wedge
`;

const Q3_SNAPSHOT_SKILL_ACCEPT_MARKDOWN = `# Q3 roadmap priorities

## Themes

- Meeting capture quality is the foundation — everything depends on it being trustworthy
- Notes UX needs polish before we push on growth
- Templates are the wedge for the next vertical

## Top items

| Priority | Owner | Status |
| --- | --- | --- |
| Transcript accuracy v2 | eng | in flight |
| Skill picker redesign | design | scoping |
| Templates v1 | product | not started |
`;

async function seedQ3SnapshotsIfMissing(
  noteIdsByKey: Map<NoteKey, number>,
): Promise<void> {
  const noteId = noteIdsByKey.get("q3-roadmap");
  if (noteId === undefined) return;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(noteSnapshots)
    .where(eq(noteSnapshots.noteId, noteId));
  if (count > 0) return;

  await saveNoteSnapshot(db, {
    noteId,
    kind: "manual",
    label: "v1 draft",
    markdown: Q3_SNAPSHOT_V1_DRAFT_MARKDOWN,
    ydocState: markdownToYDocUpdate(Q3_SNAPSHOT_V1_DRAFT_MARKDOWN),
  });
  await saveNoteSnapshot(db, {
    noteId,
    kind: "skill-accept",
    label: null,
    markdown: Q3_SNAPSHOT_SKILL_ACCEPT_MARKDOWN,
    ydocState: markdownToYDocUpdate(Q3_SNAPSHOT_SKILL_ACCEPT_MARKDOWN),
  });
}

// ---------------------------------------------------------------------------
// 8. Standalone transcriptions — dictation history
// ---------------------------------------------------------------------------

async function seedTranscriptionsIfEmpty(now: Date): Promise<void> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(transcriptions);
  if (count > 0) return;

  const entries: Array<{ text: string; daysAgo: number }> = [
    {
      text: "Follow up with the design team on the homepage trust bar mock before tomorrow's review.",
      daysAgo: 0,
    },
    {
      text: "Quick thought — the snapshot list could show a diff preview on hover, not just the label.",
      daysAgo: 1,
    },
    {
      text: "Remember to file the bug on the meetings UI slowness — re-render thrash on every keystroke.",
      daysAgo: 2,
    },
    {
      text: "Note to self: book the Paris hotels before they sell out for the October trip.",
      daysAgo: 4,
    },
  ];

  for (const entry of entries) {
    const ts = new Date(now.getTime() - entry.daysAgo * DAY_MS);
    await createTranscription({
      text: entry.text,
      timestamp: ts,
      language: "en",
      speechModel: "whisper-large-v3-turbo",
      confidence: 0.92,
    });
  }
}

// ---------------------------------------------------------------------------
// Note content
//
// Lives at the bottom of the file as a single block of `markdown` strings
// keyed by NoteKey, so the orchestration above stays compact and the prose
// stays scannable as a unit. Edit content here without touching the seed flow.
// ---------------------------------------------------------------------------

const STANDUP_MD = `## Yesterday

- Wrapped the dock animation polish
- Reviewed the new contributor's first PR

## Today

- Pair with eng on the transcript export bug
- Draft the agenda for Thursday's design review

## Blockers

- Waiting on env var access from infra
`;

const DESIGN_REVIEW_MD = `## Goals

- Land on a v1 layout we can ship in two weeks
- Agree on the empty state direction

## Discussion

- Mobile mockups still pending
- A11y review queued for next round

## Decisions

- Use the curated feed pattern, not infinite scroll
- Drop the live-meeting tile from v1 — surface it via the dock instead
`;

const CATCH_UP_EMMA_MD = `## Agenda

- Where we're landing on the homepage redesign
- Open question: demo video placement
- Anything else from her side

## Background

Emma's been leading the design side; the review with product is tomorrow morning. Want to walk in with a clear shared point of view rather than litigating live.

## Priorities

| Item | Status |
| --- | --- |
| Hero section | locked |
| Testimonials carousel | dropping |
| Trust bar replacement | needs mock |
| Headline A/B test | doc TBD |

## Things to bring up

- Reminder: copy variants for the A/B test should go through \`cross-team-eng-sync\` review before launch
- Marketing wants a heads-up on the CTA change a week ahead
- Confirm timeline — review tomorrow, design freeze Friday

> "We keep trying to fit five stories on the homepage when one would land harder." — Emma, last catch-up. Worth circling back to.
`;

const APP_ARCHITECTURE_MD = `# App architecture brainstorm

## Layers

- Main process owns persistence and IPC routing
- Renderer is thin — only UI state and tRPC calls
- \`ServiceManager\` is the singleton that holds long-lived services

## Open questions

- Where should the \`bootstrap*\` calls live? \`app-manager.ts\` is already busy
- Do we still need the separate \`tray-manager\`, or can it fold into the window manager?

## Sketch

\`\`\`typescript
class AppManager {
  private services = ServiceManager.getInstance();

  async initialize() {
    await initializeDatabase();
    await this.services.start();
  }
}
\`\`\`

The split between \`AppManager\` and \`ServiceManager\` is mostly historical — worth revisiting once the auth refactor lands.
`;

const ONBOARDING_COPY_MD = `# Onboarding flow copy

## Screen 1 — Welcome

Short, no jargon. Lead with what the app does for them, not what it does technically.

> Capture meetings and voice notes. We turn them into clean, structured notes — automatically.

## Screen 2 — Permissions

Explain the audio and accessibility permissions before asking for them. People say yes more often when they've read the why.

## Screen 3 — First note

Default the user into a real first note rather than an empty editor. Pre-fill with a "your first note" template they can keep or discard.
`;

const Q3_ROADMAP_MD = `# Q3 roadmap priorities

## Themes

- Meeting capture quality is the foundation — everything depends on it being trustworthy
- Notes UX needs polish before we push on growth
- Templates are the wedge for the next vertical

## Top items

| Priority | Owner | Status |
| --- | --- | --- |
| Transcript accuracy v2 | eng | in flight |
| Skill picker redesign | design | scoping |
| Templates v1 | product | not started |
| Folders & tags polish | eng | ready for review |

## Out of scope

- Mobile companion app
- Public sharing — defer to Q4
`;

const VOICE_INPUT_EDGES_MD = `## Known edge cases

- Long pause + resume triggers a new segment; we dedupe by \`startTimeMs\` but the boundary can drift
- Background noise (kids, dogs) bleeds into the \`mic\` source even with the noise gate on
- The \`system\` source captures meeting-room speakers when both are present — needs source priority logic
- Very short utterances under 400 ms get dropped by the VAD; intentional but worth surfacing

## Open

- Should we surface "low confidence" segments in the UI? Risk: scary, but transparency wins long term.
`;

const RELEASE_CHECKLIST_MD = `# Release checklist v2.1

## Pre-release

- [x] Bump version in package.json
- [x] Update CHANGELOG
- [ ] Tag the release commit
- [ ] Trigger the release build on CI
- [ ] Smoke-test the signed installer on a clean macOS user
- [ ] Wait for notarization to clear

## Comms

- [ ] Draft the release-note Slack post
- [ ] Email the design partners with the highlights
- [ ] Update the docs site with the new screenshots
`;

const USER_INTERVIEW_SAM_MD = `# User interview notes — Sam

Sam runs a 12-person sales team. Uses a notes app daily for prep and recap.

## On meeting prep

- Builds a quick agenda the morning of each call
- Wants the agenda to evolve into the meeting notes — not duplicate work

## On recap

- Writes 3–4 bullets right after the call, while it's fresh
- Used to dictate into a personal note then move things to the CRM later

> "The thing I'd pay for is anything that closes the gap between 'I just left the call' and 'the CRM is updated.' That handoff is where everything dies."

## Wishlist

- Tags shared with teammates
- A way to pin the most relevant past notes when starting a new call
`;

const COMPETITIVE_ANALYSIS_MD = `## Strengths vs alternatives

- Better default templates
  - Onboarding playbook
  - Customer discovery
- AI summaries land closer to what we'd actually write
- Local-first persistence — works on a plane

## Gaps

- No team sharing yet (single-user only)
- Mobile companion missing
- Limited integrations
  - Calendar: only Google
  - CRM: none yet

## Watch list

- Newer entrants in the AI-notes space — they ship fast on summaries but seem weaker on the editor side
`;

const WEEKLY_REFLECTION_MD = `# Weekly reflection

Felt scattered most of this week. Too many context switches between code review and the design alignment work — neither got the attention it needed.

Bright spot was the customer interview on Wednesday. *That conversation reframed how I think about the recap step* — we've been optimizing the wrong part of the loop.

Next week: protect two mornings for deep work, do all interviews on a single afternoon.
`;

const ACME_DISCOVERY_MD = `## Problem

- Sales reps lose context between calls — notes scattered across docs, CRM, and personal notebooks
- Manager has no visibility into pipeline conversations until after the deal closes (or loses)

## Current stack

- Salesforce for CRM (mandatory)
- Notes app for prep (varies per rep)
- Loom for share-outs

## Next steps

1. Send over a tailored deck on the meeting capture workflow
2. Schedule a 30-min demo with two reps + the manager next week
3. Loop in their RevOps lead before the demo
`;

const RIVERSTONE_RENEWAL_MD = `## Usage

- 24 active seats, mostly in customer success
- Daily active rate around 60% — strong but not stellar
- Heaviest usage in template-driven workflows

## Expansion ideas

- Open up to the sales team — 18 seats
- Pitch the meeting-capture upgrade; they've been recording manually
- Annual plan with auto-renew if they expand seats

## Risks

- Sponsor is changing roles mid-quarter — need a second champion
- They flagged the export experience as clunky in the last QBR
- Procurement cycle is slow; start the renewal paperwork early
`;

const FRANCE_TRIP_MD = `# France trip planning

## Paris (3 days)

- Musée d'Orsay morning
- Walk the Seine, end at Île de la Cité
- Day trip option: Versailles if the weather holds

## Lyon (2 days)

- Vieux Lyon afternoon
- Traboules walk
- Bouchon dinner

## Nice (2 days)

- Promenade des Anglais
- Day trip to Èze
- Beach time

## Packing

- Travel essentials
  - Passport, charger adapter, ear plugs
  - Comfortable walking shoes
  - Light rain jacket
- Tech
  - Camera + spare battery
  - Offline maps downloaded

## Restaurants to try

- Septime (Paris) — book ahead
- Le Comptoir (Paris)
- Daniel & Denise (Lyon)
- La Mère Brazier (Lyon)
`;

const VOICE_MEMO_TUESDAY_MD = `- Onboarding docs — pick up this sprint
- Meetings UI feels slow with long transcripts; profile it
- Write doc fixes today, file the bug
`;

const LECTURE_LLMS_MD = `# Lecture notes — Intro to LLMs

## Pretraining

- Self-supervised next-token prediction over web-scale text
- Tokenization is typically \`BPE\` or \`SentencePiece\`; vocabulary 32k–256k
- Data scale matters more than data quality, up to a point — the bitter lesson lurks here
- Loss curves are remarkably smooth across scales (Chinchilla)

## Architectures

| Model | Params | Notes |
| --- | --- | --- |
| \`GPT-4\` | undisclosed | mixture-of-experts rumored |
| \`Llama 3 70B\` | 70B | open weights, strong baseline |
| \`Claude 3 Opus\` | undisclosed | strong on reasoning + long context |

## Inference

- KV cache is the dominant memory cost at long context
- Decoding strategies — greedy is fast but boring; nucleus sampling balances diversity and coherence
- Speculative decoding can 2–3x throughput by drafting with a smaller model

> "General methods that leverage computation are ultimately the most effective." — the bitter lesson, paraphrased.
`;

function NOTE_SPECS(): NoteSpec[] {
  return [
    // Event-linked
    {
      key: "standup",
      title: "Product & Engineering Daily Standup",
      icon: "📋",
      eventId: "standup",
      daysAgo: 0,
      folder: "Eng Team",
      markdown: STANDUP_MD,
    },
    {
      key: "design-review",
      title: "Desktop Home Experience Design Review",
      icon: "🎨",
      eventId: "design-review",
      daysAgo: 1,
      folder: "Eng Team",
      tags: ["design", "engineering"],
      markdown: DESIGN_REVIEW_MD,
    },
    {
      key: "catch-up-emma",
      title: "Catch-up with Emma",
      icon: "☕",
      eventId: "customer-sync",
      starred: true,
      daysAgo: 2,
      folder: "Sales Team",
      tags: ["customer"],
      markdown: CATCH_UP_EMMA_MD,
    },
    // Standalone (carry-over titles unchanged)
    {
      key: "app-architecture",
      title: "App architecture brainstorm",
      icon: "🏗️",
      daysAgo: 0,
      folder: "Eng Team",
      tags: ["engineering"],
      markdown: APP_ARCHITECTURE_MD,
    },
    {
      key: "onboarding-copy",
      title: "Onboarding flow copy",
      icon: "✍️",
      daysAgo: 1,
      folder: "Eng Team",
      markdown: ONBOARDING_COPY_MD,
    },
    {
      key: "q3-roadmap",
      title: "Q3 roadmap priorities",
      icon: "🗺️",
      starred: true,
      daysAgo: 3,
      folder: "Eng Team",
      tags: ["roadmap"],
      markdown: Q3_ROADMAP_MD,
    },
    {
      key: "voice-input-edge-cases",
      title: "Voice input edge cases",
      icon: "🐛",
      daysAgo: 2,
      folder: "Eng Team",
      markdown: VOICE_INPUT_EDGES_MD,
    },
    {
      key: "release-checklist",
      title: "Release checklist v2.1",
      icon: "🚀",
      daysAgo: 4,
      folder: "Eng Team",
      tags: ["engineering"],
      markdown: RELEASE_CHECKLIST_MD,
    },
    {
      key: "user-interview-sam",
      title: "User interview notes — Sam",
      icon: "🎙️",
      daysAgo: 5,
      folder: "Sales Team",
      tags: ["customer"],
      markdown: USER_INTERVIEW_SAM_MD,
    },
    {
      key: "competitive-analysis",
      title: "Competitive analysis",
      icon: "🔍",
      daysAgo: 7,
      folder: "Sales Team",
      markdown: COMPETITIVE_ANALYSIS_MD,
    },
    {
      key: "weekly-reflection",
      title: "Weekly reflection",
      icon: "📝",
      daysAgo: 6,
      folder: "Personal",
      tags: ["weekly"],
      markdown: WEEKLY_REFLECTION_MD,
    },
    // New
    {
      key: "acme-discovery",
      title: "Acme Corp — discovery call",
      icon: "🎯",
      daysAgo: 3,
      folder: "Sales Team",
      tags: ["customer"],
      markdown: ACME_DISCOVERY_MD,
    },
    {
      key: "riverstone-renewal",
      title: "Riverstone Partners — renewal",
      icon: "🔄",
      daysAgo: 4,
      folder: "Sales Team",
      tags: ["customer"],
      markdown: RIVERSTONE_RENEWAL_MD,
    },
    {
      key: "france-trip",
      title: "France trip planning",
      icon: "🇫🇷",
      starred: true,
      daysAgo: 1,
      folder: "Family",
      markdown: FRANCE_TRIP_MD,
    },
    {
      key: "voice-memo-tuesday",
      title: "Voice memo — Tuesday morning",
      icon: "🎤",
      daysAgo: 1,
      folder: "Personal",
      markdown: VOICE_MEMO_TUESDAY_MD,
    },
    {
      key: "lecture-llms",
      title: "Lecture notes — Intro to LLMs",
      icon: "🧠",
      starred: true,
      daysAgo: 5,
      folder: "Personal",
      markdown: LECTURE_LLMS_MD,
    },
  ];
}
