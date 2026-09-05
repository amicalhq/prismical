/**
 * Shared wire helpers for the local /apps/v1/me dialect.
 *
 * Every handler resolves to a RouteResult — a completed HTTP-shaped exchange
 * (status + parsed-JSON body) that live.ts wraps into the TransportResponse
 * `{ok:true,status,bodyJson}` arm. Error BODIES mirror the fake sync server's
 * shapes (e2e/helpers/fake-sync.ts), which the contract suites pin against
 * core's dialect; the reserved `{error:{code:'INTERNAL'}}` envelope arm never
 * originates here.
 */
import type { AppsV1ErrorResponse } from '@prismical/api-contracts/apps/v1';
import type { ProductDbService } from '../../infra/product-db/service';

/** The drizzle handle handlers run against (typed by the product schema). */
export type LocalDb = ProductDbService['db'];

/** One completed exchange: HTTP status + the JSON body to echo. */
export interface RouteResult {
  readonly status: number;
  readonly body: unknown;
}

export const ok = (body: unknown, status = 200): RouteResult => ({ status, body });

export const notFound = (): RouteResult => ({
  status: 404,
  body: { error: { code: 'NOT_FOUND', message: 'Not found' } },
});

/**
 * Zod issues as `path: code (received type)` — the SHAPE of a 400, never the
 * offending values. The received type matters on the desktop transport: a
 * body crosses IPC by structured clone, so a Date survives as an object where
 * fetch would have JSON-stringified it.
 */
export const issueSummary = (
  issues: ReadonlyArray<{ path: PropertyKey[]; code: string }>,
  body?: unknown
): string =>
  issues
    .map(issue => {
      const path = issue.path.map(String).join('.') || '<root>';
      const head = issue.path[0];
      const received =
        body !== null && typeof body === 'object' && head !== undefined
          ? receivedType((body as Record<PropertyKey, unknown>)[head])
          : null;
      return `${path}: ${issue.code}${received === null ? '' : ` (received ${received})`}`;
    })
    .join('; ');

const receivedType = (value: unknown): string =>
  value === null
    ? 'null'
    : value instanceof Date
      ? 'Date'
      : Array.isArray(value)
        ? 'array'
        : typeof value;

export const invalidRequest = (message = 'Invalid request'): RouteResult => ({
  status: 400,
  body: {
    error: { code: 'INVALID_REQUEST', message },
  },
});

export const conflict = (): RouteResult => ({
  status: 409,
  body: { error: { code: 'CONFLICT', message: 'Conflict' } },
});

export const forbidden = (): RouteResult => ({
  status: 403,
  body: { error: { code: 'FORBIDDEN', message: 'Forbidden' } },
});

/**
 * Epoch-ms number, epoch-ms numeric string, or ISO 8601 → epoch ms. The
 * `since` cursor and client write stamps accept all three forms. Invalid or
 * absent → null (callers default write stamps to
 * "now" — an unstamped write is the latest write under LWW).
 */
export const parseTimestampMs = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  let ms: number;
  if (typeof value === 'number') {
    ms = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    ms = /^[+-]?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  } else {
    return null;
  }
  return Number.isFinite(ms) ? ms : null;
};

/** '1'/'true' → true — the includeDeleted/includeBody flag convention. */
export const queryFlag = (value: string | undefined): boolean =>
  value === '1' || value === 'true';

/**
 * SQLite unique-violation detection: better-sqlite3 throws a raw SqliteError
 * (the sync drizzle adapter does not wrap it) whose extended result code is
 * SQLITE_CONSTRAINT_UNIQUE for a unique INDEX collision but
 * SQLITE_CONSTRAINT_PRIMARYKEY for a primary-key one — both carry the "UNIQUE
 * constraint failed" message, which is why the message test stays. Routes map
 * either form to 409 CONFLICT.
 */
export const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error &&
  ((error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    /unique constraint failed/i.test(error.message));

/**
 * The server's canonical error envelope:
 * `{ error: { code, message, details? } }`. The skills lanes speak this shape
 * — the client matches `err.code` on it (NOTE_EMPTY, TRANSCRIPT_FINALIZING,
 * …), so the strings are API surface and must stay byte-identical.
 */
export const apiError = (
  status: number,
  code: string,
  message: string,
  details?: unknown
): RouteResult => ({
  status,
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } } satisfies AppsV1ErrorResponse,
});

/**
 * A driver/ORM error for a log line: class + SQLite result code ONLY. Never
 * `String(error)` — a driver message can embed bound values or SQL, i.e. the
 * note title, the Ask conversation, the generated markdown. better-sqlite3's
 * SqliteError carries the code at the top level; a wrapping error (drizzle's
 * DrizzleQueryError, `Failed query: <sql>\nparams: <every bound value>`) is
 * read through its cause.
 */
export const describeDbError = (error: unknown): string => {
  if (!(error instanceof Error)) return typeof error;
  const ownCode = (error as { code?: unknown }).code;
  const cause = (error as { cause?: unknown }).cause;
  const code =
    typeof ownCode === 'string'
      ? ownCode
      : cause !== null &&
          typeof cause === 'object' &&
          typeof (cause as { code?: unknown }).code === 'string'
        ? (cause as { code: string }).code
        : cause instanceof Error
          ? cause.name
          : null;
  return code === null ? error.name : `${error.name}/${code}`;
};
