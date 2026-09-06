// @vitest-environment jsdom
/**
 * Note↔event link hooks over the Legend-State sync store. The store is real (createSyncStore)
 * with a mocked wire layer; useSyncStore is mocked to hand the hooks that store, exactly as the
 * provider would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

vi.mock("../../sync/api", () => ({
  restList: vi.fn(async () => []),
  restCreate: vi.fn(),
  restUpdate: vi.fn(),
  restRemove: vi.fn(async () => undefined),
  restNoteTagList: vi.fn(async () => []),
  restNoteTagCreate: vi.fn(async () => undefined),
  restNoteTagRemove: vi.fn(async () => undefined),
  restNoteEventList: vi.fn(async () => []),
  restNoteEventCreate: vi.fn(),
  restNoteEventRemove: vi.fn(async () => undefined),
}));
vi.mock("../../sync/provider", () => ({ useSyncStore: vi.fn() }));

import * as api from "../../sync/api";
import { useSyncStore } from "../../sync/provider";
import type { NoteEventLocalRow } from "../../sync/api";
import { createSyncStore, type NoteEventRow, type SyncStore } from "../../sync/store";
import { useNotes } from "./notes";
import { useLinkNoteEvent, useNoteEvents, useSetPrimaryNoteEvent, useUnlinkNoteEvent } from "./note-events";

const mockedApi = vi.mocked(api);
const mockedUseStore = vi.mocked(useSyncStore);

const T = "2030-01-01T00:00:00.000Z";
const EVENT = { id: "cev_mine", key: "uid-1@x:single", title: "Roadmap", start: T, end: T, calendarColor: "#123" };
const wireLink = (over: Partial<NoteEventLocalRow> & { linkId: string }): NoteEventLocalRow => ({
  id: `${over.noteId ?? "nt_a"}:${over.eventKey ?? EVENT.key}`,
  noteId: "nt_a",
  eventKey: EVENT.key,
  seriesKey: "uid-1@x",
  eventId: "cev_mine",
  isPrimary: true,
  source: "user",
  title: "Roadmap",
  startsAt: T,
  endsAt: T,
  meetingUrl: null,
  createdAt: T,
  updatedAt: T,
  deletedAt: null,
  ...over,
});
const noteRow = (id: string, eventId: string | null = null) => ({
  id,
  title: id,
  titleSource: "manual",
  eventId,
  folderId: null,
  starred: false,
  createdAt: T,
  updatedAt: T,
});

let store: SyncStore;

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.restList.mockResolvedValue([]);
  mockedApi.restNoteTagList.mockResolvedValue([]);
  mockedApi.restNoteEventList.mockResolvedValue([]);
  // The echo is the server's row: its key is the EVENT's key (the same one the client keyed on).
  const KEY_OF: Record<string, string> = { cev_mine: EVENT.key, cev_two: "uid-2@x:single" };
  mockedApi.restNoteEventCreate.mockImplementation(async (body) =>
    wireLink({
      linkId: "nev_new",
      noteId: body.noteId,
      eventId: body.eventId,
      eventKey: KEY_OF[body.eventId] ?? body.eventId,
      isPrimary: body.isPrimary ?? true,
    }),
  );
  store = createSyncStore({ partition: { accountSub: "sub", orgId: "org" }, pollIntervalMs: 0 });
  mockedUseStore.mockReturnValue(store);
});

afterEach(() => {
  store.dispose();
});

describe("useNoteEvents", () => {
  it("lists a note's links primary first, resolved to MY event row (or none for a collaborator's link)", async () => {
    mockedApi.restNoteEventList.mockResolvedValueOnce([
      wireLink({ linkId: "nev_1", eventKey: "k-second", eventId: null, isPrimary: false, title: "Their 1:1", updatedAt: "2030-01-02T00:00:00.000Z" }),
      wireLink({ linkId: "nev_2" }),
      wireLink({ linkId: "nev_3", noteId: "nt_other", eventKey: "k-other", eventId: "cev_other" }),
    ]);
    const { result } = renderHook(() => useNoteEvents("nt_a"));
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(result.current.data!.map((l) => [l.eventKey, l.eventId, l.isPrimary])).toEqual([
      [EVENT.key, "cev_mine", true],
      ["k-second", undefined, false],
    ]);
    expect(result.current.data![1]).toMatchObject({ title: "Their 1:1", source: "user" });
  });

  it("gives the note its eventId from the primary link, not from the row's transitional column", async () => {
    // The row column carries the LINKER's event row; this reader resolves the same link to their own.
    mockedApi.restList.mockResolvedValueOnce([noteRow("nt_a", "cev_linker"), noteRow("nt_fresh", "cev_fresh")]);
    mockedApi.restNoteEventList.mockResolvedValueOnce([wireLink({ linkId: "nev_1", eventId: "cev_mine" })]);
    const { result } = renderHook(() => useNotes());
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    await waitFor(() => expect(result.current.data!.find((n) => n.id === "nt_a")!.eventId).toBe("cev_mine"));
    // No link row yet (a note this device just created): the column still paints.
    expect(result.current.data!.find((n) => n.id === "nt_fresh")!.eventId).toBe("cev_fresh");
  });
});

describe("useLinkNoteEvent / useSetPrimaryNoteEvent / useUnlinkNoteEvent", () => {
  it("links optimistically (first link is primary) and POSTs {noteId, eventId}", async () => {
    // Reading the collection activates it (as the provider does at boot); writes to an
    // unactivated collection are not pushed.
    const links = renderHook(() => useNoteEvents("nt_a"));
    await waitFor(() => expect(links.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useLinkNoteEvent("nt_a"));
    result.current.mutate({ event: EVENT });
    const row = (store.noteEvents$.peek() as Record<string, NoteEventRow>)[`nt_a:${EVENT.key}`];
    expect(row).toMatchObject({ noteId: "nt_a", eventId: "cev_mine", isPrimary: true, source: "user", title: "Roadmap" });
    expect(row!.createdAt).toBeUndefined();
    await waitFor(() =>
      expect(mockedApi.restNoteEventCreate).toHaveBeenCalledWith({ noteId: "nt_a", eventId: "cev_mine", isPrimary: true }),
    );
    // The echo carries the server row id for later unlinks.
    await waitFor(() =>
      expect((store.noteEvents$.peek() as Record<string, NoteEventRow>)[`nt_a:${EVENT.key}`]!.linkId).toBe("nev_new"),
    );
  });

  it("a second link is not primary; promoting it re-POSTs with isPrimary and demotes the other locally", async () => {
    mockedApi.restNoteEventList.mockResolvedValueOnce([wireLink({ linkId: "nev_1" })]);
    const links = renderHook(() => useNoteEvents("nt_a"));
    await waitFor(() => expect(links.result.current.data).toHaveLength(1));
    const second = { ...EVENT, id: "cev_two", key: "uid-2@x:single", title: "Design" };
    renderHook(() => useLinkNoteEvent("nt_a")).result.current.mutate({ event: second });
    await waitFor(() => expect(links.result.current.data?.map((l) => l.eventKey).sort()).toEqual([EVENT.key, second.key].sort()));
    expect(links.result.current.data!.find((l) => l.eventKey === second.key)!.isPrimary).toBe(false);
    await waitFor(() =>
      expect(mockedApi.restNoteEventCreate).toHaveBeenCalledWith({ noteId: "nt_a", eventId: "cev_two", isPrimary: false }),
    );

    renderHook(() => useSetPrimaryNoteEvent("nt_a")).result.current.mutate(second.key);
    await waitFor(() => {
      const byKey = new Map(links.result.current.data!.map((l) => [l.eventKey, l.isPrimary]));
      expect(byKey.get(second.key)).toBe(true);
      expect(byKey.get(EVENT.key)).toBe(false);
    });
    await waitFor(() =>
      expect(mockedApi.restNoteEventCreate).toHaveBeenCalledWith({ noteId: "nt_a", eventId: "cev_two", isPrimary: true }),
    );
  });

  it("unlinks by the server row id; the undo of an automatic link declines it", async () => {
    mockedApi.restNoteEventList.mockResolvedValueOnce([
      wireLink({ linkId: "nev_auto", source: "auto" }),
      wireLink({ linkId: "nev_user", eventKey: "k-user", eventId: "cev_u", isPrimary: false }),
    ]);
    const links = renderHook(() => useNoteEvents("nt_a"));
    await waitFor(() => expect(links.result.current.data).toHaveLength(2));
    const unlink = renderHook(() => useUnlinkNoteEvent("nt_a"));
    unlink.result.current.mutate({ eventKey: EVENT.key, decline: true });
    await waitFor(() => expect(mockedApi.restNoteEventRemove).toHaveBeenCalledWith("nev_auto", true));
    unlink.result.current.mutate({ eventKey: "k-user" });
    await waitFor(() => expect(mockedApi.restNoteEventRemove).toHaveBeenCalledWith("nev_user", false));
    await waitFor(() => expect(links.result.current.data).toHaveLength(0));
  });

  it("a link to an event without a key is refused locally (nothing to key the row on)", async () => {
    const links = renderHook(() => useNoteEvents("nt_a"));
    await waitFor(() => expect(links.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useLinkNoteEvent("nt_a"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    result.current.mutate({ event: { ...EVENT, key: undefined } });
    expect(Object.keys((store.noteEvents$.peek() as object | undefined) ?? {})).toHaveLength(0);
    expect(mockedApi.restNoteEventCreate).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("a note created from a meeting", () => {
  it("re-pulls the links as soon as the create is acked, so the chip does not wait for the next poll", async () => {
    const links = renderHook(() => useNoteEvents("nt_new"));
    await waitFor(() => expect(links.result.current.isSuccess).toBe(true));
    const pullsBefore = mockedApi.restNoteEventList.mock.calls.length;
    mockedApi.restCreate.mockImplementationOnce(async (_route, input) => ({
      ...(input as object),
      createdAt: T,
      eventId: "cev_mine",
    }));
    mockedApi.restNoteEventList.mockResolvedValueOnce([wireLink({ linkId: "nev_srv", noteId: "nt_new" })]);
    const notes = renderHook(() => useNotes()); // activates the notes collection
    await waitFor(() => expect(notes.result.current.isSuccess).toBe(true));
    const id = store.createNote({ titleIntent: "default", eventId: "cev_mine" });
    await waitFor(() => expect(mockedApi.restCreate).toHaveBeenCalledTimes(1));
    await store.whenNoteCreateAcked(id, 3_000);
    await waitFor(() => expect(mockedApi.restNoteEventList.mock.calls.length).toBeGreaterThan(pullsBefore), { timeout: 3_000 });
    await waitFor(() => expect(links.result.current.data?.map((l) => l.eventId)).toEqual(["cev_mine"]));
  });
});

describe("what a note create tells the server about its event", () => {
  it("a plain New note sends NO eventId (the server may auto-link it); naming null opts out", async () => {
    const notes = renderHook(() => useNotes());
    await waitFor(() => expect(notes.result.current.isSuccess).toBe(true));
    store.createNote({ titleIntent: "default" });
    await waitFor(() => expect(mockedApi.restCreate).toHaveBeenCalledTimes(1));
    expect(mockedApi.restCreate.mock.calls[0]![1]).not.toHaveProperty("eventId");
    store.createNote({ titleIntent: "default", eventId: null });
    await waitFor(() => expect(mockedApi.restCreate).toHaveBeenCalledTimes(2));
    expect(mockedApi.restCreate.mock.calls[1]![1]).toMatchObject({ eventId: null });
  });
});
