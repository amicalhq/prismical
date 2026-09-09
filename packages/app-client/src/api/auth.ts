import { diagnosticHeaders } from "../diagnostics";
// The single auth seam. The AuthProvider keeps liveToken in sync via
// setAuthToken; getAuthHeaders prefers it, falling back to the dev env token.

// `process.env` is statically replaced by Next in the web bundle (and undefined
// in the desktop renderer, which uses main-owned tokens); this package carries
// no node types, so declare just the shape the dev-token fallback below reads.
declare const process: { env: Record<string, string | undefined> };

let liveToken: string | null = null;
let tokenSuspended = false;

/** Called by the AuthProvider whenever the session's id_token changes. */
export function setAuthToken(token: string | null): void {
  liveToken = token;
  if (token) tokenSuspended = false;
}

/** Fail closed across a sensitive session teardown, including in dev where a
 * configured fallback token must not inherit work from the ended session. */
export function suspendAuthToken(): void {
  liveToken = null;
  tokenSuspended = true;
}

// The active organization pick, mirrored from the session by the AuthProvider. This
// single seam is the source of org scope for EVERY request: regular data hooks
// don't pass an org, so they use it by default. Cross-org cache safety comes from
// resetting the React Query cache on switch (OrgScopedCacheReset), not from the
// query keys — keys carry no org. The only caller that overrides is
// `useOrganizations`, which passes `null` to omit the header (so listing
// organizations never 403s on a stale pick).
let activeOrgId: string | null = null;

/** Called by the AuthProvider whenever the session's active org changes. */
export function setActiveOrgId(id: string | null): void {
  activeOrgId = id;
}

// The interface locale the user chose in the app, sent as `x-prismical-locale` so core renders
// user-facing copy (AI error messages and their recovery actions) in that language instead of
// guessing from Accept-Language. Set by the i18n provider whenever the applied locale changes.
let requestLocale: string | null = null;

export function setRequestLocale(locale: string | null): void {
  requestLocale = locale;
}

function withLocale(headers: Record<string, string>): Record<string, string> {
  if (requestLocale) headers["x-prismical-locale"] = requestLocale;
  return { ...diagnosticHeaders(), ...headers };
}

/**
 * Build request headers. `orgIdOverride`:
 *  - omitted        → use the module-level active org (default).
 *  - a string       → send that org as `x-active-org-id`.
 *  - null           → explicitly send NO active-org header (e.g. /me/organizations,
 *                     which must succeed regardless of any stale pick).
 */
export function getAuthHeaders(orgIdOverride?: string | null): Record<string, string> {
  const token = getAuthToken();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const active = orgIdOverride === undefined ? activeOrgId : orgIdOverride;
  if (active) headers["x-active-org-id"] = active;
  return withLocale(headers);
}

/**
 * Build headers from a caller-pinned bearer. Long-running web work uses this
 * so an account/session switch cannot silently restamp the request with the
 * newly active login's token.
 */
export function getAuthHeadersForToken(
  token: string,
  orgIdOverride?: string | null,
): Record<string, string> {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const active = orgIdOverride === undefined ? activeOrgId : orgIdOverride;
  if (active) headers["x-active-org-id"] = active;
  return withLocale(headers);
}

/** The raw bearer token (live, else dev fallback), or null if absent/empty.
 *  Uses `||` so an empty-string token collapses to null. Used by the Hocuspocus provider. */
export function getAuthToken(): string | null {
  if (tokenSuspended) return null;
  const devToken =
    process.env.NODE_ENV !== "production" ? process.env.NEXT_PUBLIC_DEV_ID_TOKEN : undefined;
  return liveToken || devToken || null;
}

let unauthorizedHandler: (() => void) | null = null;

/** Register what happens on a 401 (e.g. redirect to login). */
export function setUnauthorizedHandler(fn: () => void): void {
  unauthorizedHandler = fn;
}

export function onUnauthorized(): void {
  unauthorizedHandler?.();
}
