import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../runtime", () => ({ coreApiBaseUrl: () => "https://core.test", getClientTransport: () => null }));
vi.mock("../api/auth", () => ({
  getAuthHeaders: () => ({ Authorization: "Bearer t" }),
  getAuthHeadersForToken: (token: string, orgId: string | null) => ({
    Authorization: `Bearer ${token}`,
    ...(orgId ? { "x-active-org-id": orgId } : {}),
  }),
  onUnauthorized: vi.fn(),
}));

import {
  restCreate,
  restList,
  restNoteTagCreate,
  restNoteTagList,
  restNoteTagRemove,
  restRemove,
  restUpdate,
} from "./api";

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
}
afterEach(() => vi.restoreAllMocks());

const calledUrl = (f: ReturnType<typeof vi.fn>): string => f.mock.calls[0]![0] as string;
const calledInit = (f: ReturnType<typeof vi.fn>): RequestInit => f.mock.calls[0]![1] as RequestInit;

describe("restList (delta pull)", () => {
  it("first pull (no cursor): versioned path, no since, no includeDeleted", async () => {
    const f = mockFetch(200, { success: true, results: [] });
    vi.stubGlobal("fetch", f);
    await restList("tags");
    expect(calledUrl(f)).toBe("https://core.test/apps/v1/me/tags");
  });

  it("incremental pull: since as ISO + includeDeleted=1", async () => {
    const f = mockFetch(200, { success: true, results: [] });
    vi.stubGlobal("fetch", f);
    const ms = Date.UTC(2030, 0, 1);
    await restList("tags", ms);
    const url = new URL(calledUrl(f));
    expect(url.pathname).toBe("/apps/v1/me/tags");
    expect(url.searchParams.get("since")).toBe(new Date(ms).toISOString());
    expect(url.searchParams.get("includeDeleted")).toBe("1");
  });
});

describe("writes (envelope + applied observability)", () => {
  it("restCreate POSTs to the versioned path and unwraps result", async () => {
    const f = mockFetch(201, { success: true, result: { id: "tag_x" }, applied: true, created: true });
    vi.stubGlobal("fetch", f);
    const row = await restCreate<{ id: string }>("tags", { id: "tag_x", name: "A" });
    expect(row).toEqual({ id: "tag_x" });
    expect(calledUrl(f)).toBe("https://core.test/apps/v1/me/tags");
    expect(calledInit(f)).toMatchObject({ method: "POST" });
  });

  it("stamps a caller-pinned exact-session token and organization", async () => {
    const f = mockFetch(201, {
      success: true,
      result: { id: "tag_support" },
      applied: true,
      created: true,
    });
    vi.stubGlobal("fetch", f);
    await restCreate(
      "tags",
      { id: "tag_support", name: "Support" },
      { authToken: "support-token", activeOrgId: "org_support" },
    );

    expect(new Headers(calledInit(f).headers).get("authorization")).toBe(
      "Bearer support-token",
    );
    expect(new Headers(calledInit(f).headers).get("x-active-org-id")).toBe(
      "org_support",
    );
  });

  it("applied:false returns the SERVER-winning row and logs the LWW loss", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      mockFetch(200, { success: true, result: { id: "tag_x", name: "ServerWins" }, applied: false, created: false }),
    );
    const row = await restCreate<{ id: string; name: string }>("tags", { id: "tag_x", name: "LocalIntent" });
    expect(row.name).toBe("ServerWins");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not applied"));
  });

  it("restUpdate PUTs to /:id and unwraps the envelope", async () => {
    const f = mockFetch(200, { success: true, result: { id: "tag_x", color: "#1" }, applied: true });
    vi.stubGlobal("fetch", f);
    const row = await restUpdate<{ id: string; color: string }>("tags", "tag_x", { name: "B" });
    expect(row.color).toBe("#1");
    expect(calledUrl(f)).toBe("https://core.test/apps/v1/me/tags/tag_x");
    expect(calledInit(f)).toMatchObject({ method: "PUT" });
  });

  it("restRemove DELETEs /:id", async () => {
    const f = mockFetch(200, { success: true });
    vi.stubGlobal("fetch", f);
    await restRemove("tags", "tag_x");
    expect(calledUrl(f)).toBe("https://core.test/apps/v1/me/tags/tag_x");
    expect(calledInit(f)).toMatchObject({ method: "DELETE" });
  });
});

describe("note-tags junction mapping", () => {
  it("list synthesizes the composite id Legend keys on", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(200, {
        success: true,
        results: [{ noteId: "nt_a", tagId: "tag_b", updatedAt: "2030-01-01T00:00:00.000Z" }],
      }),
    );
    const rows = await restNoteTagList();
    expect(rows).toEqual([
      { id: "nt_a:tag_b", noteId: "nt_a", tagId: "tag_b", updatedAt: "2030-01-01T00:00:00.000Z" },
    ]);
  });

  it("create POSTs {noteId, tagId}; remove DELETEs the composite path", async () => {
    const f = mockFetch(201, { success: true, result: { noteId: "nt_a", tagId: "tag_b" } });
    vi.stubGlobal("fetch", f);
    await restNoteTagCreate("nt_a", "tag_b");
    expect(calledUrl(f)).toBe("https://core.test/apps/v1/me/note-tags");
    expect(JSON.parse(calledInit(f).body as string)).toEqual({ noteId: "nt_a", tagId: "tag_b" });

    const g = mockFetch(200, { success: true });
    vi.stubGlobal("fetch", g);
    await restNoteTagRemove("nt_a", "tag_b");
    expect(calledUrl(g)).toBe("https://core.test/apps/v1/me/note-tags/nt_a/tag_b");
    expect(calledInit(g)).toMatchObject({ method: "DELETE" });
  });
});
