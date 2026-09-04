import type { TransportMethod, TransportPort } from "@prismical/app-contracts";
import { ApiErrorResponseSchema } from "@prismical/api-contracts";
import { coreApiBaseUrl, getClientTransport } from "../runtime";
import { getAuthHeaders, getAuthHeadersForToken, onUnauthorized } from "./auth";

/**
 * Versioned alias for the server's first-party "app-only" sync lane. Every route that
 * used to live only at `/me/...` is now ALSO reachable at this prefix (same handler, same auth,
 * same shapes) — the bare `/me/...` path stays as a permanent legacy alias, but the webapp should
 * call the versioned path going forward.
 */
export const ME_PREFIX = "/apps/v1/me";

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type QueryParams = Record<string, string | number | boolean | string[] | undefined | null>;

interface RequestOptions {
  query?: QueryParams;
  body?: unknown;
  /** Send cookies (for cookie-auth routes like /me/plan). */
  credentials?: boolean;
  /** Abort the request (e.g. the Stop button on a billable skill run). */
  signal?: AbortSignal;
  /**
   * Active organization for this call (`x-active-org-id`). Pass the same org id used
   * in the React Query key so the wire header can't drift from the cache key.
   * `null` explicitly omits the header (org-agnostic routes like /me/organizations);
   * omitted falls back to the module-level active org.
   */
  activeOrgId?: string | null;
  /** Pin a long-running operation to the bearer that owns it. */
  authToken?: string;
}

function buildUrl(path: string, query?: QueryParams): string {
  const url = `${coreApiBaseUrl()}${path}`;
  if (!query) return url;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((v) => qs.append(key, v));
    else qs.append(key, String(value));
  }
  const s = qs.toString();
  return s ? `${url}?${s}` : url;
}

function toApiError(json: unknown, status: number, statusText: string): ApiError {
  const contracted = ApiErrorResponseSchema.safeParse(json);
  if (contracted.success) {
    const { code, message, details } = contracted.data.error;
    return new ApiError(code, message, status, details);
  }
  const body = (json ?? {}) as { error?: unknown; message?: unknown; details?: unknown };
  // Nested envelope: { error: { code, message, details } } (the common case)
  if (body.error && typeof body.error === "object") {
    const e = body.error as { code?: string; message?: string; details?: unknown };
    return new ApiError(e.code ?? "UNKNOWN", e.message ?? statusText, status, e.details);
  }
  // Flat shape used by a few handlers (e.g. /me/search): { error: "Invalid request", message?, details? }
  if (typeof body.error === "string") {
    const code = body.error.trim().toUpperCase().replace(/\s+/g, "_") || "UNKNOWN";
    const message = typeof body.message === "string" ? body.message : body.error;
    return new ApiError(code, message, status, body.details);
  }
  return new ApiError("UNKNOWN", statusText, status);
}

/**
 * The desktop REST lane: route the same method/path/query/body through the
 * injected TransportPort (→ main's CloudTransport IPC) instead of a direct
 * fetch, so the renderer never learns core's address. Auth headers are NOT
 * stamped here — main owns them behind the transport. Any completed exchange is
 * `{ ok, status, bodyJson }`; the error arm (network / disallowed path /
 * unavailable session) surfaces as an ApiError, which the query hooks catch
 * (retry:false) and render as an empty/error state.
 */
async function requestViaTransport<T>(
  transport: TransportPort,
  method: string,
  path: string,
  opts: RequestOptions,
): Promise<T> {
  let query: Record<string, string> | undefined;
  if (opts.query) {
    query = {};
    for (const [key, value] of Object.entries(opts.query)) {
      if (value === undefined || value === null) continue;
      // The IPC query envelope is Record<string,string>; array params (repeated
      // keys) collapse to a joined value.
      query[key] = Array.isArray(value) ? value.join(",") : String(value);
    }
  }
  const res = await transport.request({
    method: method as TransportMethod,
    path,
    ...(query ? { query } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
  if ("error" in res) {
    throw new ApiError(res.error.code, res.error.message ?? res.error.code, 0);
  }
  if (!(res.status >= 200 && res.status < 300)) {
    if (res.status === 401) onUnauthorized();
    throw toApiError(res.bodyJson, res.status, String(res.status));
  }
  return res.bodyJson as T;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const transport = getClientTransport();
  if (transport) return requestViaTransport<T>(transport, method, path, opts);
  const res = await fetch(buildUrl(path, opts.query), {
    method,
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.authToken
        ? getAuthHeadersForToken(opts.authToken, opts.activeOrgId)
        : getAuthHeaders(opts.activeOrgId)),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    ...(opts.credentials ? { credentials: "include" } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
    throw toApiError(json, res.status, res.statusText);
  }
  return json as T;
}

interface ListEnvelope<T> {
  results: T[];
}
interface ResultEnvelope<T> {
  result: T;
}

type OrgOpt = { activeOrgId?: string | null; authToken?: string };

export const apiClient = {
  list: async <T>(path: string, query?: QueryParams, opts?: OrgOpt): Promise<T[]> =>
    (await request<ListEnvelope<T>>("GET", path, {
      query,
      activeOrgId: opts?.activeOrgId,
      authToken: opts?.authToken,
    }))
      .results ?? [],
  get: async <T>(path: string, query?: QueryParams, opts?: OrgOpt): Promise<T> =>
    (await request<ResultEnvelope<T>>("GET", path, {
      query,
      activeOrgId: opts?.activeOrgId,
      authToken: opts?.authToken,
    }))
      .result,
  post: async <T>(
    path: string,
    body: unknown,
    opts?: { signal?: AbortSignal } & OrgOpt,
  ): Promise<T> =>
    (
      await request<ResultEnvelope<T>>("POST", path, {
        body,
        signal: opts?.signal,
        activeOrgId: opts?.activeOrgId,
        authToken: opts?.authToken,
      })
    ).result,
  put: async <T>(path: string, body: unknown, opts?: OrgOpt): Promise<T> =>
    (await request<ResultEnvelope<T>>("PUT", path, {
      body,
      activeOrgId: opts?.activeOrgId,
      authToken: opts?.authToken,
    }))
      .result,
  patch: async <T>(path: string, body: unknown, opts?: OrgOpt): Promise<T> =>
    (await request<ResultEnvelope<T>>("PATCH", path, {
      body,
      activeOrgId: opts?.activeOrgId,
      authToken: opts?.authToken,
    }))
      .result,
  del: async (path: string, opts?: OrgOpt): Promise<void> => {
    await request<{ success: true }>("DELETE", path, {
      activeOrgId: opts?.activeOrgId,
      authToken: opts?.authToken,
    });
  },
  /** For DELETE endpoints whose acknowledgement must be runtime-validated. */
  delRaw: <T>(path: string, opts?: OrgOpt): Promise<T> =>
    request<T>("DELETE", path, {
      activeOrgId: opts?.activeOrgId,
      authToken: opts?.authToken,
    }),
  /** For endpoints whose envelope carries extra fields (search, plan). */
  getRaw: <T>(path: string, query?: QueryParams, opts?: OrgOpt): Promise<T> =>
    request<T>("GET", path, {
      query,
      credentials: true,
      activeOrgId: opts?.activeOrgId,
      authToken: opts?.authToken,
    }),
  /** For POST endpoints with a flat envelope (e.g. authorize → { url }, sync → { success }). */
  postRaw: <T>(
    path: string,
    body?: unknown,
    opts?: OrgOpt & { credentials?: boolean },
  ): Promise<T> =>
    request<T>("POST", path, {
      ...(body === undefined ? {} : { body }),
      credentials: opts?.credentials,
      activeOrgId: opts?.activeOrgId,
      authToken: opts?.authToken,
    }),
  /** For PATCH endpoints with a flat envelope (e.g. /me/mcp-servers/:id → the updated server). */
  patchRaw: <T>(path: string, body: unknown, opts?: OrgOpt): Promise<T> =>
    request<T>("PATCH", path, {
      body,
      activeOrgId: opts?.activeOrgId,
      authToken: opts?.authToken,
    }),
  /** For PUT endpoints where the caller needs the full envelope (the sync lane reads `applied`). */
  putRaw: <T>(path: string, body: unknown, opts?: OrgOpt): Promise<T> =>
    request<T>("PUT", path, {
      body,
      activeOrgId: opts?.activeOrgId,
      authToken: opts?.authToken,
    }),
};
