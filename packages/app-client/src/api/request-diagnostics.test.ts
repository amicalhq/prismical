import { afterEach, expect, it, vi } from "vitest";
import { clientRequestId, safeApiRoute } from "./request-diagnostics";

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["/apps/v1/me/notes/nt_example?token=private#private", "/apps/v1/me/notes/:redacted"],
  ["/me/connections/person%40example.com/authorize", "/me/connections/:redacted/authorize"],
  ["https://private.invalid/path", "[redacted]"],
  ["//private.invalid/path", "[redacted]"],
  ["/me/unknown-secret", "/me/:redacted"],
])("redacts untrusted path data in %s", (path, expected) => {
  expect(safeApiRoute(path)).toBe(expected);
});

it("tolerates unavailable random ID generation", () => {
  vi.stubGlobal("crypto", undefined);
  expect(clientRequestId()).toBeUndefined();
});
