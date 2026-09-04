import { describe, expect, it } from "vitest";
import {
  emojiFromIconUrl, iconUrlFromEmoji,
  toNote, toFolder, toTag, toSkill, toVocabulary,
  toConnection, toCalendarEvent,
  noteUpdateBody,
} from "./adapters";

describe("emoji ↔ iconUrl", () => {
  it("treats a bare emoji as the emoji", () => {
    expect(emojiFromIconUrl("📝")).toBe("📝");
  });
  it("treats a URL as no emoji", () => {
    expect(emojiFromIconUrl("https://x/y.png")).toBeUndefined();
  });
  it("treats empty string as no emoji", () => {
    expect(emojiFromIconUrl("")).toBeUndefined();
  });
  it("round-trips an emoji into iconUrl", () => {
    expect(iconUrlFromEmoji("📝")).toBe("📝");
    expect(iconUrlFromEmoji(undefined)).toBeNull();
  });
});

describe("toNote", () => {
  it("maps core note metadata to the UI Note", () => {
    const note = toNote({
      id: "note_1", title: "Hi", iconUrl: "📝", starred: true,
      folderId: "folder_1", eventId: null, updatedAt: "2026-06-09T00:00:00Z",
      contentText: "body text here",
    });
    expect(note).toMatchObject({
      id: "note_1", title: "Hi", emoji: "📝", starred: true,
      folderId: "folder_1", tagIds: [], body: "body text here",
    });
    expect(note.preview.length).toBeGreaterThan(0);
  });
  it("defaults missing optionals", () => {
    const note = toNote({ id: "note_2", title: "", iconUrl: null, starred: false, folderId: null, updatedAt: "2026-06-09T00:00:00Z" });
    expect(note.emoji).toBeUndefined();
    expect(note.folderId).toBeUndefined();
    expect(note.body).toBe("");
    expect(note.tagIds).toEqual([]);
  });
  it("builds a whitespace-collapsed, 140-char-capped preview", () => {
    const note = toNote({
      id: "note_3", title: "T", iconUrl: null, starred: false, folderId: null,
      updatedAt: "2026-06-09T00:00:00Z", contentText: "word ".repeat(200),
    });
    expect(note.preview.length).toBeLessThanOrEqual(140);
    expect(note.preview).not.toMatch(/\s{2,}/);
  });
  it("derives the preview from the plaintext excerpt, not the markdown body", () => {
    const note = toNote({
      id: "note_md", title: "T", iconUrl: null, starred: false, folderId: null,
      updatedAt: "2026-06-09T00:00:00Z",
      // body is markdown (includeBody); excerpt is the plaintext preview.
      contentText: "## Heading\n\n- bullet item",
      excerpt: "Heading bullet item",
    });
    expect(note.body).toBe("## Heading\n\n- bullet item"); // body stays markdown for copy/export
    expect(note.preview).toBe("Heading bullet item"); // preview is clean plaintext, no `##`/`-`
    expect(note.preview).not.toContain("#");
  });
  it("maps canWrite:false to writable:false", () => {
    const note = toNote({ id: "n", updatedAt: "2026-06-09T00:00:00Z", canWrite: false });
    expect(note.writable).toBe(false);
  });
  it("defaults writable to true when canWrite is absent", () => {
    const note = toNote({ id: "n", updatedAt: "2026-06-09T00:00:00Z" });
    expect(note.writable).toBe(true);
  });
});

describe("toFolder / toTag / toSkill / toVocabulary", () => {
  it("renames isFavorite -> favorite", () => {
    expect(toFolder({ id: "folder_1", name: "F", parentId: null, isFavorite: true, createdAt: "2026-06-09T00:00:00Z" }).favorite).toBe(true);
    expect(toTag({ id: "tag_1", name: "T", color: "#fff", isFavorite: false, createdAt: "2026-06-09T00:00:00Z" }).favorite).toBe(false);
  });
  it("merges skill preference enabled flag", () => {
    const s = toSkill(
      { id: "skill_1", name: "S", description: "d", body: "b", system: false, createdAt: "2026-06-09T00:00:00Z", updatedAt: "2026-06-09T00:00:00Z", config: { editingOptions: "append-section", surface: ["dock"], defaultSkill: false, modeAgnosticPrompt: false } },
      true,
    );
    expect(s.enabled).toBe(true);
    expect(s.slug).toBeTruthy();
  });
  it("maps vocabulary replacement fields", () => {
    const v = toVocabulary({ id: "vocabulary_1", word: "k8s", replacementWord: "Kubernetes", isReplacement: true, usageCount: 3, updatedAt: "2026-06-09T00:00:00Z" });
    expect(v).toMatchObject({ id: "vocabulary_1", word: "k8s", replacement: "Kubernetes", uses: 3 });
  });
});

describe("noteUpdateBody", () => {
  it("maps a UI patch to the core write body", () => {
    expect(noteUpdateBody({ title: "New", starred: true, emoji: "🚀", folderId: "folder_9" })).toEqual({
      title: "New", starred: true, iconUrl: "🚀", folderId: "folder_9",
    });
  });
  it("maps emoji removal to null iconUrl and folder removal to null", () => {
    expect(noteUpdateBody({ emoji: undefined, folderId: undefined })).toEqual({ iconUrl: null, folderId: null });
  });
  it("includes ONLY keys present in the patch (omit = untouched)", () => {
    expect(noteUpdateBody({ starred: true })).toEqual({ starred: true });
  });
  it("preserves falsy-but-present values", () => {
    expect(noteUpdateBody({ title: "", starred: false })).toEqual({ title: "", starred: false });
  });
});

describe("toConnection", () => {
  it("maps wire nulls to undefined", () => {
    const c = toConnection({
      id: "cn_1", provider: "google", status: "active",
      statusReason: null, accountEmail: "a@b.co", lastSyncedAt: null,
    });
    expect(c).toEqual({
      id: "cn_1", provider: "google", status: "active",
      syncMode: undefined, statusReason: undefined, accountEmail: "a@b.co",
      deviceId: undefined, deviceName: undefined, lastSyncedAt: undefined,
    });
  });

  it("maps an EventKit installation without pretending it is an OAuth account", () => {
    expect(toConnection({
      id: "cn_device", provider: "eventkit", syncMode: "device_push", status: "active",
      deviceId: "device-1", deviceName: "Naomi's MacBook", accountEmail: null,
    })).toMatchObject({
      id: "cn_device", provider: "eventkit", syncMode: "device_push",
      deviceId: "device-1", deviceName: "Naomi's MacBook", accountEmail: undefined,
    });
  });
});

describe("toCalendarEvent", () => {
  const base = {
    id: "event_1", calendarId: "calendar_1", title: "Standup",
    startsAt: "2026-06-09T10:00:00Z", endsAt: "2026-06-09T10:30:00Z",
    updatedAt: "2026-06-09T00:00:00Z",
  };
  it("maps core event fields to the UI CalendarEvent", () => {
    const e = toCalendarEvent({ ...base, meetingUrl: "https://meet.google.com/x" }, "#ff0000");
    expect(e).toMatchObject({
      id: "event_1", title: "Standup",
      start: "2026-06-09T10:00:00Z", end: "2026-06-09T10:30:00Z",
      calendarColor: "#ff0000", joinUrl: "https://meet.google.com/x",
    });
  });
  it("returns null without a start time", () => {
    expect(toCalendarEvent({ ...base, startsAt: null })).toBeNull();
  });
  it("falls back: end → start, color → default, empty title → placeholder", () => {
    const e = toCalendarEvent({ ...base, title: "", endsAt: null });
    expect(e).toMatchObject({ title: "(untitled)", end: base.startsAt });
    expect(e?.calendarColor).toBeTruthy();
  });
  it("maps raw attendees to display names, skipping rooms and junk", () => {
    const e = toCalendarEvent({
      ...base,
      attendees: [
        { email: "a@b.co", displayName: "Ada" },
        { email: "room@b.co", displayName: "Room 1", resource: true },
        { email: "plain@b.co" },
        "not-an-object",
        {},
      ],
    });
    expect(e?.attendees).toEqual(["Ada", "plain@b.co"]);
  });
  it("maps normalized EventKit attendee names", () => {
    const e = toCalendarEvent({
      ...base,
      attendees: [{ email: "eventkit@b.co", name: "EventKit Guest", status: "accepted" }],
    });
    expect(e?.attendees).toEqual(["EventKit Guest"]);
  });
  it("treats a non-array attendees payload as absent", () => {
    expect(toCalendarEvent({ ...base, attendees: { weird: true } })?.attendees).toBeUndefined();
  });
});
