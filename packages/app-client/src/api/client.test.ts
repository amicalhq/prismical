import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../runtime", () => ({ coreApiBaseUrl: () => "https://core.test", getClientTransport: () => null }));
vi.mock("./auth", () => ({
  getAuthHeaders: () => ({ Authorization: "Bearer t" }),
  getAuthHeadersForToken: (token: string) => ({ Authorization: `Bearer ${token}` }),
  onUnauthorized: vi.fn(),
}));

import { apiClient, ApiError } from "./client";
import { onUnauthorized } from "./auth";

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
}
afterEach(() => vi.restoreAllMocks());

describe("apiClient", () => {
  it("list() unwraps results and sends the auth header", async () => {
    const f = mockFetch(200, { success: true, results: [{ id: "a" }, { id: "b" }] });
    vi.stubGlobal("fetch", f);
    const rows = await apiClient.list<{ id: string }>("/me/tags");
    expect(rows).toEqual([{ id: "a" }, { id: "b" }]);
    expect(f).toHaveBeenCalledWith(
      "https://core.test/me/tags",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer t" }) }),
    );
  });
  it("get() unwraps result", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { success: true, result: { id: "x" } }));
    expect(await apiClient.get<{ id: string }>("/me/notes/x")).toEqual({ id: "x" });
  });
  it("post() unwraps result", async () => {
    vi.stubGlobal("fetch", mockFetch(201, { success: true, result: { id: "n" }, created: true }));
    expect(await apiClient.post<{ id: string }>("/me/notes", { title: "t" })).toEqual({ id: "n" });
  });
  it("uses a caller-pinned bearer instead of the globally active token", async () => {
    const f = mockFetch(201, { success: true, result: { id: "n" } });
    vi.stubGlobal("fetch", f);

    await apiClient.post("/me/notes", { title: "t" }, { authToken: "owner-token" });

    expect(f).toHaveBeenCalledWith(
      "https://core.test/me/notes",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer owner-token" }),
      }),
    );
  });
  it("maps an error envelope to ApiError", async () => {
    vi.stubGlobal("fetch", mockFetch(404, { error: { code: "NOT_FOUND", message: "Not found" } }));
    await expect(apiClient.get("/me/notes/none")).rejects.toMatchObject({
      name: "ApiError", code: "NOT_FOUND", status: 404,
    });
  });
  it("calls onUnauthorized on 401", async () => {
    vi.stubGlobal("fetch", mockFetch(401, { error: { code: "UNAUTHORIZED", message: "no" } }));
    await expect(apiClient.list("/me/tags")).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalled();
  });
  it("builds a querystring from params", async () => {
    const f = mockFetch(200, { success: true, results: [] });
    vi.stubGlobal("fetch", f);
    await apiClient.list("/me/notes", { includeBody: 1, folder: "f1" });
    expect(f.mock.calls[0]![0]).toBe("https://core.test/me/notes?includeBody=1&folder=f1");
  });
  it("maps a flat string error body to ApiError", async () => {
    vi.stubGlobal("fetch", mockFetch(400, { error: "Invalid request", message: "bad query", details: { query: ["required"] } }));
    await expect(apiClient.getRaw("/me/search")).rejects.toMatchObject({
      name: "ApiError", code: "INVALID_REQUEST", message: "bad query", status: 400,
    });
  });
  it("list() returns [] on an empty 2xx body", async () => {
    vi.stubGlobal("fetch", mockFetch(200, {}));
    expect(await apiClient.list("/me/tags")).toEqual([]);
  });
});
