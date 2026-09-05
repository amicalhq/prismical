import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../runtime", () => ({
  coreApiBaseUrl: () => "https://core.test",
  getClientTransport: vi.fn(() => null),
}));
vi.mock("./auth", () => ({
  getAuthHeaders: () => ({ Authorization: "Bearer t" }),
  getAuthHeadersForToken: (token: string) => ({ Authorization: `Bearer ${token}` }),
  onUnauthorized: vi.fn(),
}));

import { apiClient, ApiError } from "./client";
import { onUnauthorized } from "./auth";
import { getClientTransport } from "../runtime";
import { aiUserErrorOf } from "../errors/ai-user-error";

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
}
afterEach(() => vi.restoreAllMocks());

describe("apiClient", () => {
  it.each(["http", "desktop"])("preserves actionable error details over %s", async (transport) => {
    const details = {
      lane: "your-key",
      retryable: true,
      retryAfterMs: 3000,
      user: {
        title: "Please wait",
        severity: "warning",
        actions: [{ kind: "retry", label: "Try again" }],
      },
    };
    const body = {
      error: {
        code: "PROVIDER_RATE_LIMITED",
        message: "Rate limited",
        details,
        requestId: "request_1",
      },
    };
    if (transport === "http") vi.stubGlobal("fetch", mockFetch(429, body));
    else
      vi.mocked(getClientTransport).mockReturnValueOnce({
        request: vi.fn().mockResolvedValue({ ok: true, status: 429, bodyJson: body }),
      });

    const error = await apiClient.get("/apps/v1/me/check").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: "PROVIDER_RATE_LIMITED",
      status: 429,
      details,
      requestId: "request_1",
    });
    expect(aiUserErrorOf(error)).toEqual(details.user);
  });
  it("retains domain codes and correlation fields from app errors", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(409, {
        error: {
          code: "TITLE_CHANGED",
          message: "Title changed",
          traceId: "trace_1",
          requestId: "request_1",
          localizedMessage: { locale: "fr", message: "Le titre a changé" },
        },
      }),
    );
    await expect(apiClient.get("/apps/v1/me/notes/a")).rejects.toMatchObject({
      code: "TITLE_CHANGED",
      message: "Title changed",
      status: 409,
      traceId: "trace_1",
      requestId: "request_1",
      localizedMessage: { locale: "fr", message: "Le titre a changé" },
    });
  });
  it("list() unwraps results and sends the auth header", async () => {
    const f = mockFetch(200, { results: [{ id: "a" }, { id: "b" }] });
    vi.stubGlobal("fetch", f);
    const rows = await apiClient.list<{ id: string }>("/me/tags");
    expect(rows).toEqual([{ id: "a" }, { id: "b" }]);
    expect(f).toHaveBeenCalledWith(
      "https://core.test/me/tags",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer t" }) }),
    );
  });
  it("get() returns the resource directly", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { id: "x" }));
    expect(await apiClient.get<{ id: string }>("/me/notes/x")).toEqual({ id: "x" });
  });
  it("post() preserves meaningful sync metadata", async () => {
    vi.stubGlobal("fetch", mockFetch(201, { result: { id: "n" }, created: true }));
    expect(await apiClient.post("/me/notes", { title: "t" })).toEqual({
      result: { id: "n" },
      created: true,
    });
  });
  it("returns undefined for HTTP 204 without parsing JSON", async () => {
    const json = vi.fn().mockRejectedValue(new SyntaxError("Empty body"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 204, ok: true, json }));

    expect(await apiClient.delRaw("/me/tags/a")).toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });
  it("normalizes desktop 204 acknowledgements to undefined", async () => {
    vi.mocked(getClientTransport).mockReturnValueOnce({
      request: vi.fn().mockResolvedValue({ ok: true, status: 204, bodyJson: null }),
    });

    expect(await apiClient.delRaw("/me/tags/a")).toBeUndefined();
  });
  it("uses a caller-pinned bearer instead of the globally active token", async () => {
    const f = mockFetch(201, { id: "n" });
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
    const f = mockFetch(200, { results: [] });
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
