import { reportClientError } from "../diagnostics";
import { clientRequestId, safeApiRoute } from "./request-diagnostics";
import type { TransportMethod, TransportPort } from "@prismical/app-contracts";
import {
  AppsV1ErrorResponseSchema,
  type AppsV1ErrorResponse,
} from "@prismical/api-contracts/apps/v1";
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
  traceId?: string;
  requestId?: string;
  localizedMessage?: AppsV1ErrorResponse["error"]["localizedMessage"];
  constructor(
    code: string,
    message: string,
    status: number,
    details?: unknown,
    metadata?: Pick<AppsV1ErrorResponse["error"], "traceId" | "requestId" | "localizedMessage">,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.traceId = metadata?.traceId;
    this.requestId = metadata?.requestId;
    this.localizedMessage = metadata?.localizedMessage;
  }
}

export type QueryParams = Record<string, string | number | boolean | string[] | undefined | null>;

interface RequestOptions {
  onResponse?: (requestId: string | null) => void;
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
  const contracted = AppsV1ErrorResponseSchema.safeParse(json);
  if (contracted.success) {
    const error = contracted.data.error;
    return new ApiError(error.code, error.message, status, error.details, error);
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
  return (res.status === 204 ? undefined : res.bodyJson) as T;
}

async function performRequest<T>(method: string, path: string, opts: RequestOptions = {}, correlationId?: string): Promise<T> {
  const res = await fetch(buildUrl(path, opts.query), {
    method,
    headers: {
      ...(correlationId ? { "x-client-request-id": correlationId } : {}),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.authToken
        ? getAuthHeadersForToken(opts.authToken, opts.activeOrgId)
        : getAuthHeaders(opts.activeOrgId)),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    ...(opts.credentials ? { credentials: "include" } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  // Diagnostics must never change request behavior.
  try {
    opts.onResponse?.(res.headers.get("x-request-id"));
  } catch {
    /* best effort */
  }
  const json = res.status === 204 ? undefined : await res.json().catch(() => ({}));

  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
    const error = toApiError(json, res.status, res.statusText);
    error.requestId ??= res.headers?.get("x-request-id") ?? undefined;
    throw error;
  }
  return json as T;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const transport = getClientTransport();
  const correlationId = transport ? undefined : clientRequestId();
  try {
    return await (transport
      ? requestViaTransport<T>(transport, method, path, opts)
      : performRequest<T>(method, path, opts, correlationId));
  } catch (error) {
    if (!opts.signal?.aborted) reportClientError(error, {
      operation: "api", method, route: safeApiRoute(path), client_request_id: correlationId,
    });
    throw error;
  }
}

interface ListEnvelope<T> {
  results: T[];
}

type OrgOpt = { activeOrgId?: string | null; authToken?: string };

export const apiClient = {
  list: async <T>(path: string, query?: QueryParams, opts?: OrgOpt): Promise<T[]> =>
    (
      await request<ListEnvelope<T>>("GET", path, {
        query,
        activeOrgId: opts?.activeOrgId,
        authToken: opts?.authToken,
      })
    ).results ?? [],
  get: async <T>(path: string, query?: QueryParams, opts?: OrgOpt): Promise<T> =>
    request<T>("GET", path, {
      query,
      activeOrgId: opts?.activeOrgId,
      authToken: opts?.authToken,
    }),
  post: async <T>(
    path: string,
    body: unknown,
    opts?: { signal?: AbortSignal; onResponse?: (requestId: string | null) => void } & OrgOpt,
  ): Promise<T> =>
    request<T>("POST", path, {
      body,
      signal: opts?.signal,
      onResponse: opts?.onResponse,
      activeOrgId: opts?.activeOrgId,
      authToken: opts?.authToken,
    }),
  put: async <T>(path: string, body: unknown, opts?: OrgOpt & { signal?: AbortSignal }): Promise<T> =>
    request<T>("PUT", path, {
      body,
      signal: opts?.signal,
      activeOrgId: opts?.activeOrgId,
      authToken: opts?.authToken,
    }),
  patch: async <T>(path: string, body: unknown, opts?: OrgOpt): Promise<T> =>
    request<T>("PATCH", path, {
      body,
      activeOrgId: opts?.activeOrgId,
      authToken: opts?.authToken,
    }),
  del: async (path: string, opts?: OrgOpt): Promise<void> => {
    await request<unknown>("DELETE", path, {
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
  /** GET with session cookies for routes that support cookie authentication. */
  getRaw: <T>(
    path: string,
    query?: QueryParams,
    opts?: OrgOpt & { signal?: AbortSignal },
  ): Promise<T> =>
    request<T>("GET", path, {
      query,
      signal: opts?.signal,
      credentials: true,
      activeOrgId: opts?.activeOrgId,
      authToken: opts?.authToken,
    }),
  /** POST with an optional body and optional session cookies. */
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
  /** Return the complete PATCH response. */
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
