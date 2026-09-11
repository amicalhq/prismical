// @vitest-environment jsdom
/**
 * Tag hooks over the Legend-State sync store (same harness as
 * folders.test.ts). Pins the tag-specific behaviors: auto-color assignment,
 * name sanitization before the wire, and colliding-name REUSE instead of a
 * guaranteed-409 create.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

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
import { createSyncStore, type SyncStore } from "../../sync/store";
import { useTags, useCreateTag, useUpdateTag, useDeleteTag } from "./tags";

import { useAllNoteTags, useAddNoteTag } from "./note-tags";
import { ApiError } from "../client";

const mockedApi = vi.mocked(api);
const mockedUseStore = vi.mocked(useSyncStore);

let store: SyncStore;

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.restList.mockResolvedValue([]);
  mockedApi.restNoteTagList.mockResolvedValue([]);
  mockedApi.restCreate.mockImplementation(async (_route, input) => ({
    ...(input as object),
    createdAt: "2030-01-01T00:00:00.000Z",
  }));
  mockedApi.restUpdate.mockImplementation(async (_route, _id, input) => ({ ...(input as object) }));
  store = createSyncStore({ partition: { accountSub: "sub", orgId: "org" }, pollIntervalMs: 0 });
  mockedUseStore.mockReturnValue(store);
});

afterEach(() => {
  store.dispose();
});

describe("useTags + useCreateTag", () => {
  it("creates optimistically with a sanitized name and an auto color; POST pushed without createdAt", async () => {
    const { result: tags } = renderHook(() => useTags());
    await waitFor(() => expect(tags.current.isSuccess).toBe(true));
    const { result: create } = renderHook(() => useCreateTag());
    const tag = await create.current.mutateAsync("My Work!");
    expect(tag.name).toBe("MyWork"); // sanitized BEFORE the wire
    expect(tag.color).toBeTruthy(); // auto-assigned
    await waitFor(() => expect(tags.current.data!.some((t) => t.name === "MyWork")).toBe(true));
    await waitFor(() => expect(mockedApi.restCreate).toHaveBeenCalledTimes(1));
    const sent = mockedApi.restCreate.mock.calls[0]![1] as Record<string, unknown>;
    expect(sent.createdAt).toBeUndefined();
  });

  it("creates with the color the caller picked", async () => {
    const { result: tags } = renderHook(() => useTags());
    await waitFor(() => expect(tags.current.isSuccess).toBe(true));
    const { result: create } = renderHook(() => useCreateTag());
    const tag = await create.current.mutateAsync({ name: "Roadmap", color: "#7f77dd" });
    expect(tag.color).toBe("#7f77dd");
  });

  it("REUSES a case-insensitively colliding live tag instead of creating into a 409", async () => {
    mockedApi.restList.mockResolvedValueOnce([
      { id: "tag_work", name: "Work", color: "#1", isFavorite: false, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" },
    ]);
    const { result: tags } = renderHook(() => useTags());
    await waitFor(() => expect(tags.current.data?.length).toBe(1));
    const { result: create } = renderHook(() => useCreateTag());
    const tag = await create.current.mutateAsync("w o r k");
    expect(tag.id).toBe("tag_work"); // reused, no create pushed
    expect(mockedApi.restCreate).not.toHaveBeenCalled();
  });
});

describe("useUpdateTag + useDeleteTag", () => {
  it("a pure recolor never re-sends the name; delete tombstones", async () => {
    mockedApi.restList.mockResolvedValueOnce([
      { id: "tag_x", name: "legacy-name", color: "#1", isFavorite: false, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" },
    ]);
    const { result: tags } = renderHook(() => useTags());
    await waitFor(() => expect(tags.current.data?.length).toBe(1));

    const { result: update } = renderHook(() => useUpdateTag());
    update.current.mutate({ id: "tag_x", patch: { color: "#2" } });
    await waitFor(() => expect(mockedApi.restUpdate).toHaveBeenCalled());
    const body = mockedApi.restUpdate.mock.calls[0]![2] as Record<string, unknown>;
    expect(body.color).toBe("#2");
    // A legacy name containing '-' must NOT ride along (it would get re-normalized).
    expect(body.name).toBeUndefined();

    const { result: del } = renderHook(() => useDeleteTag());
    del.current.mutate("tag_x");
    await waitFor(() => expect(tags.current.data!.length).toBe(0));
    await waitFor(() => expect(mockedApi.restRemove).toHaveBeenCalledWith("tags", "tag_x"));
  });

  it("a rename IS sanitized on the way through", async () => {
    mockedApi.restList.mockResolvedValueOnce([
      { id: "tag_y", name: "Y", color: "#1", isFavorite: false, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" },
    ]);
    const { result: tags } = renderHook(() => useTags());
    await waitFor(() => expect(tags.current.data?.length).toBe(1));
    const { result: update } = renderHook(() => useUpdateTag());
    update.current.mutate({ id: "tag_y", patch: { name: "new name!" } });
    await waitFor(() => expect(tags.current.data![0]!.name).toBe("newname"));
  });
});


describe("tag creation edge cases", () => {
  it("does not reuse a legacy punctuation name for a distinct clean name", async () => {
    mockedApi.restList.mockResolvedValueOnce([
      { id: "tag_legacy", name: "follow-up", color: "#1", createdAt: "2030-01-01T00:00:00Z", updatedAt: "2030-01-01T00:00:00Z" },
    ]);
    const { result: tags } = renderHook(() => useTags());
    await waitFor(() => expect(tags.current.data).toHaveLength(1));
    const { result: create } = renderHook(() => useCreateTag());
    let createdId = "";
    await act(async () => { createdId = (await create.current.mutateAsync("followup")).id; });
    expect(createdId).not.toBe("tag_legacy");
    await waitFor(() => expect(mockedApi.restCreate).toHaveBeenCalledTimes(1));
    expect(tags.current.data?.map(tag => tag.name)).toEqual(expect.arrayContaining(["follow-up", "followup"]));
  });

  it("rolls back rejected tag and attachment without breaking subscribed lists or later creates", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedApi.restCreate.mockRejectedValueOnce(new ApiError("CONFLICT", "collision", 409));
    mockedApi.restNoteTagCreate.mockRejectedValueOnce(new ApiError("NOT_FOUND", "missing tag", 404));
    const { result: tags } = renderHook(() => useTags());
    const { result: links } = renderHook(() => useAllNoteTags());
    await waitFor(() => expect(tags.current.isSuccess && links.current.isSuccess).toBe(true));
    const { result: create } = renderHook(() => useCreateTag());
    const { result: add } = renderHook(() => useAddNoteTag("note_existing"));
    await act(async () => {
      const tag = await create.current.mutateAsync("Rejected");
      add.current.mutate(tag.id);
    });
    await waitFor(() => expect(mockedApi.restNoteTagCreate).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(tags.current.data).toEqual([]);
      expect(links.current.data).toEqual([]);
    });
    expect(errors.mock.calls.flat().map(String).join(" ")).not.toContain("failed to revert");
    await act(async () => { await create.current.mutateAsync("Next"); });
    await waitFor(() => expect(tags.current.data?.map(tag => tag.name)).toEqual(["Next"]));
    errors.mockRestore();
  });
});
