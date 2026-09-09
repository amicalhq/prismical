import { describe, expect, it, vi, afterEach } from "vitest";
import { configureClientDiagnostics } from "../diagnostics";
import {
  getAuthHeaders,
  getAuthHeadersForToken,
  getAuthToken,
  setAuthToken,
  suspendAuthToken,
  setUnauthorizedHandler,
  onUnauthorized,
} from "./auth";

afterEach(() => { vi.unstubAllEnvs(); configureClientDiagnostics(); });

describe("getAuthHeaders", () => {
  it("returns a bearer header when a dev token is present", () => {
    vi.stubEnv("NEXT_PUBLIC_DEV_ID_TOKEN", "tok123");
    expect(getAuthHeaders()).toEqual({ Authorization: "Bearer tok123" });
  });
  it("returns an empty object when no token is present", () => {
    vi.stubEnv("NEXT_PUBLIC_DEV_ID_TOKEN", "");
    expect(getAuthHeaders()).toEqual({});
  });
  it("prefers the live token set by the auth provider", () => {
    setAuthToken("live-tok");
    expect(getAuthHeaders()).toEqual({ Authorization: "Bearer live-tok" });
    setAuthToken(null);
  });
  it("can pin a request to an explicit owner token", () => {
    setAuthToken("new-active-token");

    expect(getAuthHeadersForToken("owner-token", "org_1")).toEqual({
      Authorization: "Bearer owner-token",
      "x-active-org-id": "org_1",
    });
    setAuthToken(null);
  });
});

describe("getAuthToken", () => {
  it("returns the live token when set", () => {
    setAuthToken("live-123");
    expect(getAuthToken()).toBe("live-123");
    setAuthToken(null);
  });

  it("suppresses the dev fallback after a sensitive session teardown", () => {
    process.env.NEXT_PUBLIC_DEV_ID_TOKEN = "dev-tok";
    suspendAuthToken();
    expect(getAuthToken()).toBeNull();
    setAuthToken("fresh-login-token");
    expect(getAuthToken()).toBe("fresh-login-token");
    setAuthToken(null);
  });
  it("falls back to the dev token in non-prod", () => {
    setAuthToken(null);
    vi.stubEnv("NEXT_PUBLIC_DEV_ID_TOKEN", "dev-tok");
    expect(getAuthToken()).toBe("dev-tok");
  });
  it("returns null when nothing is set", () => {
    setAuthToken(null);
    vi.stubEnv("NEXT_PUBLIC_DEV_ID_TOKEN", "");
    expect(getAuthToken()).toBeNull();
  });
});

describe("onUnauthorized", () => {
  it("invokes the registered handler", () => {
    const fn = vi.fn();
    setUnauthorizedHandler(fn);
    onUnauthorized();
    expect(fn).toHaveBeenCalledOnce();
  });
});


it("attaches replay correlation without overriding the request owner credentials", () => {
  configureClientDiagnostics({ captureException: vi.fn(), requestHeaders: () => ({
    "x-client-session-id": "01900000-0000-7000-8000-000000000001", Authorization: "wrong",
  }) });
  expect(getAuthHeadersForToken("owner", "org_1")).toMatchObject({
    Authorization: "Bearer owner", "x-active-org-id": "org_1",
    "x-client-session-id": "01900000-0000-7000-8000-000000000001",
  });
});
