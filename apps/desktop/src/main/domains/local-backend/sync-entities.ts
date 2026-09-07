/*
 * The generic dialect is intentionally untyped over the concrete Drizzle
 * table: it indexes columns dynamically across heterogeneous sqliteTables,
 * which Drizzle's column types do not expose structurally. The `any` casts are
 * confined to this file.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Generic sync-entity lanes over the product store: the
 * 4-route LWW dialect (GET delta / POST upsert / PUT /:id / DELETE /:id),
 * replayed against SQLite. Semantics pinned by
 * tests/contract/backend-conformance.test.ts (and, for the fake twin,
 * tests/contract/fake-sync-contract.test.ts):
 *
 *  - delta list: STRICT `updatedAt > since` (epoch-ms or ISO), tombstones only
 *    under includeDeleted, deterministic (updatedAt, id) ASC order, per-entity
 *    queryFilters (?noteId= / ?recordingId=);
 *  - LWW upsert keyed by the CLIENT-minted prefixed id (wrong prefix → 400);
 *    the client `updatedAt` is stored VERBATIM (absent/unparseable → now);
 *    stale → 200 {applied:false, result:<winner>}; a tombstoned row can be
 *    LWW-updated but NEVER revived (the request schemas strip deletedAt);
 *  - PUT updates an EXISTING row only (404 otherwise); DELETE tombstones
 *    (deletedAt + updatedAt bump), replay → 404 (the client treats it as ack);
 *  - request bodies are validated/sanitized by the api-contracts
 *    Sync*Request schemas — their .strip() IS the payload sanitizer, and the
 *    tag lane's NormalizedSyncTagNameSchema normalizes names on the way in
 *    (case-insensitive live collision → 409).
 */
import { and, asc, eq, getTableColumns, gt, isNull, type SQL } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { createId, getEntityPrefix, isValidPrefixedId } from '@prismical/id';
import {
  SyncArtifactCreateRequestSchema,
  SyncArtifactUpdateRequestSchema,
  SyncFolderCreateRequestSchema,
  SyncFolderUpdateRequestSchema,
  SyncRecordingCreateRequestSchema,
  SyncRecordingUpdateRequestSchema,
  SyncTagCreateRequestSchema,
  SyncTagUpdateRequestSchema,
  SyncTranscriptSegmentCreateRequestSchema,
  SyncTranscriptSegmentUpdateRequestSchema,
  SyncVocabularyCreateRequestSchema,
  SyncVocabularyUpdateRequestSchema,
} from '@prismical/api-contracts/apps/v1';
import * as schema from '../../infra/product-db/schema';
import {
  conflict,
  invalidRequest,
  isUniqueViolation,
  notFound,
  ok,
  parseTimestampMs,
  queryFlag,
  type LocalDb,
  type RouteResult,
} from './wire';

/** Structural zod surface — keeps this module off zod's generics treadmill. */
interface BodySchema {
  safeParse(input: unknown): { readonly success: boolean; readonly data?: unknown };
}

export interface LocalEntityConfig {
  readonly route: string;
  /** @prismical/id entity — the required id prefix (nt_/fld_/tag_/…). */
  readonly idEntity:
    | 'folder'
    | 'tag'
    | 'vocabulary'
    | 'recording'
    | 'transcriptSegment'
    | 'artifact'
    | 'skill';
  readonly table: SQLiteTable;
  readonly createSchema: BodySchema;
  readonly updateSchema: BodySchema;
  /** Query parameter → column key. */
  readonly queryFilters?: Readonly<Record<string, string>>;
  /** Post-strip payload normalization. */
  readonly sanitize?: (fields: Record<string, unknown>) => Record<string, unknown>;
  /** Shape a stored row for the wire (list rows + write echoes) — e.g. isSystem → system. */
  readonly present?: (row: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Refuse a PUT/POST-update/DELETE on a row (a 4xx RouteResult) — e.g. a
   * system skill is not deletable and only its `enabled` flag is writable.
   * `fields` are the sanitized columns the write would set (empty on delete).
   */
  readonly guardMutation?: (
    row: Record<string, unknown>,
    op: 'update' | 'delete',
    fields: Record<string, unknown>
  ) => RouteResult | null;
}

/** Write-stamp columns the client can never set directly (engine parity). */
const SERVER_COLUMNS = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt']);

/** string|number → ISO, null/absent preserved — recording startedAt/endedAt. */
const toIsoOrNull = (value: unknown): string | null => {
  const ms = parseTimestampMs(value);
  return ms === null ? null : new Date(ms).toISOString();
};

export const LOCAL_SYNC_ENTITIES: readonly LocalEntityConfig[] = [
  {
    route: 'folders',
    idEntity: 'folder',
    table: schema.folder,
    createSchema: SyncFolderCreateRequestSchema,
    updateSchema: SyncFolderUpdateRequestSchema,
  },
  {
    route: 'tags',
    idEntity: 'tag',
    table: schema.tag,
    createSchema: SyncTagCreateRequestSchema,
    updateSchema: SyncTagUpdateRequestSchema,
  },
  {
    route: 'vocabulary',
    idEntity: 'vocabulary',
    table: schema.vocabulary,
    createSchema: SyncVocabularyCreateRequestSchema,
    updateSchema: SyncVocabularyUpdateRequestSchema,
  },
  {
    route: 'recordings',
    idEntity: 'recording',
    table: schema.recording,
    createSchema: SyncRecordingCreateRequestSchema,
    updateSchema: SyncRecordingUpdateRequestSchema,
    queryFilters: { noteId: 'noteId' },
    // Store wire timestamps as ISO text. Fields absent from the local product
    // schema are dropped by the column filter below.
    sanitize: fields => ({
      ...fields,
      ...('startedAt' in fields ? { startedAt: toIsoOrNull(fields.startedAt) } : {}),
      ...('endedAt' in fields ? { endedAt: toIsoOrNull(fields.endedAt) } : {}),
    }),
  },
  {
    route: 'transcript-segments',
    idEntity: 'transcriptSegment',
    table: schema.transcriptSegment,
    createSchema: SyncTranscriptSegmentCreateRequestSchema,
    updateSchema: SyncTranscriptSegmentUpdateRequestSchema,
    queryFilters: { recordingId: 'recordingId' },
  },
  {
    route: 'artifacts',
    idEntity: 'artifact',
    table: schema.artifact,
    createSchema: SyncArtifactCreateRequestSchema,
    updateSchema: SyncArtifactUpdateRequestSchema,
    queryFilters: { noteId: 'noteId' },
  },
];

const writableKeysCache = new Map<LocalEntityConfig, ReadonlySet<string>>();

/** Table column keys the client may write (schema keys ∩ columns, minus server columns). */
const writableKeys = (entity: LocalEntityConfig): ReadonlySet<string> => {
  const cached = writableKeysCache.get(entity);
  if (cached !== undefined) return cached;
  const keys = new Set(
    Object.keys(getTableColumns(entity.table)).filter(key => !SERVER_COLUMNS.has(key))
  );
  writableKeysCache.set(entity, keys);
  return keys;
};

/**
 * Keep only real table columns: the zod strip already dropped unknown keys,
 * but a request schema may carry fields the local schema does not model
 * (artifact.generator) — those must not reach the
 * INSERT. Dropping them silently keeps payload sanitization consistent.
 */
const pickColumns = (
  entity: LocalEntityConfig,
  payload: Record<string, unknown>
): Record<string, unknown> => {
  const keys = writableKeys(entity);
  return Object.fromEntries(Object.entries(payload).filter(([key]) => keys.has(key)));
};

const selectById = async (
  db: LocalDb,
  entity: LocalEntityConfig,
  id: string
): Promise<Record<string, any> | undefined> => {
  const table = entity.table as any;
  const rows = await db.select().from(table).where(eq(table.id, id)).limit(1);
  return rows[0] as Record<string, any> | undefined;
};

/**
 * The tag lane's case-insensitive uniqueness over LIVE rows. The SQLite
 * product schema has no matching index, so the collision is checked here.
 */
const findTagCollision = async (
  db: LocalDb,
  name: string,
  excludeId: string | undefined
): Promise<boolean> => {
  const rows = await db
    .select({ id: schema.tag.id, name: schema.tag.name })
    .from(schema.tag)
    .where(isNull(schema.tag.deletedAt));
  const lower = name.toLowerCase();
  return rows.some(row => row.id !== excludeId && row.name.toLowerCase() === lower);
};

/** GET /{route}?since&includeDeleted[&filters] — the delta pull. */
export const listEntity = async (
  db: LocalDb,
  entity: LocalEntityConfig,
  query: Record<string, string>
): Promise<RouteResult> => {
  const table = entity.table as any;
  const conds: SQL[] = [];
  const sinceMs = parseTimestampMs(query.since);
  // ISO TEXT comparison is chronological here: every stored stamp is a
  // fixed-width toISOString() value.
  if (sinceMs !== null) conds.push(gt(table.updatedAt, new Date(sinceMs).toISOString()));
  if (!queryFlag(query.includeDeleted)) conds.push(isNull(table.deletedAt));
  for (const [param, column] of Object.entries(entity.queryFilters ?? {})) {
    const value = query[param];
    if (value) conds.push(eq(table[column], value));
  }
  const rows = await db
    .select()
    .from(table)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(asc(table.updatedAt), asc(table.id));
  const present = entity.present;
  return ok({
    results: present ? (rows as Record<string, unknown>[]).map(present) : rows,
  });
};

interface ParsedWrite {
  readonly id: string | undefined;
  readonly incomingMs: number;
  readonly fields: Record<string, unknown>;
}

/** Validate and sanitize one write body, or reject it with 400. */
const parseWrite = (
  entity: LocalEntityConfig,
  schema_: BodySchema,
  body: unknown
): ParsedWrite | RouteResult => {
  const parsed = schema_.safeParse(body);
  if (!parsed.success) return invalidRequest();
  const { id, updatedAt, ...payload } = parsed.data as Record<string, unknown>;
  const providedId = typeof id === 'string' ? id : undefined;
  if (providedId !== undefined && !isValidPrefixedId(entity.idEntity, providedId)) {
    return invalidRequest(
      `Invalid id "${providedId}": expected a "${getEntityPrefix(entity.idEntity)}_"-prefixed id`
    );
  }
  const fields = pickColumns(entity, entity.sanitize ? entity.sanitize(payload) : payload);
  return { id: providedId, incomingMs: parseTimestampMs(updatedAt) ?? Date.now(), fields };
};

const isRouteResult = (value: ParsedWrite | RouteResult): value is RouteResult => 'status' in value;

const echo = (entity: LocalEntityConfig, row: Record<string, any> | undefined): unknown =>
  row !== undefined && entity.present ? entity.present(row) : row;

/** POST /{route} — LWW upsert keyed by the client-minted id. */
export const upsertEntity = async (
  db: LocalDb,
  entity: LocalEntityConfig,
  body: unknown
): Promise<RouteResult> => {
  const parsed = parseWrite(entity, entity.createSchema, body);
  if (isRouteResult(parsed)) return parsed;
  const table = entity.table as any;
  const existing = parsed.id !== undefined ? await selectById(db, entity, parsed.id) : undefined;

  if (
    entity.route === 'tags' &&
    typeof parsed.fields.name === 'string' &&
    (await findTagCollision(db, parsed.fields.name, existing?.id as string | undefined))
  ) {
    return conflict();
  }

  try {
    if (existing !== undefined) {
      // LWW: ignore stale writes; the server-winning row rides back.
      if (parsed.incomingMs < Date.parse(existing.updatedAt as string)) {
        return ok({ result: echo(entity, existing), applied: false, created: false });
      }
      const guarded = entity.guardMutation?.(existing, 'update', parsed.fields);
      if (guarded) return guarded;
      const updated = (await db
        .update(table)
        .set({ ...parsed.fields, updatedAt: new Date(parsed.incomingMs).toISOString() })
        .where(eq(table.id, existing.id))
        .returning()) as Record<string, any>[];
      return ok({ result: echo(entity, updated[0]), applied: true, created: false });
    }
    const inserted = (await db
      .insert(table)
      .values({
        ...parsed.fields,
        id: parsed.id ?? createId(entity.idEntity),
        createdAt: new Date().toISOString(),
        // Client stamps stored VERBATIM — LWW consequences of client clocks
        // are the writer's problem, exactly as on the cloud lane.
        updatedAt: new Date(parsed.incomingMs).toISOString(),
        deletedAt: null,
      })
      .returning()) as Record<string, any>[];
    return ok({ result: echo(entity, inserted[0]), applied: true, created: true }, 201);
  } catch (error) {
    if (isUniqueViolation(error)) return conflict();
    throw error;
  }
};

/** PUT /{route}/:id — LWW partial update of an EXISTING row only. */
export const updateEntity = async (
  db: LocalDb,
  entity: LocalEntityConfig,
  id: string,
  body: unknown
): Promise<RouteResult> => {
  // The id here is the URL path param — reject a malformed one as 400 (not a
  // 404 miss), matching the update contract.
  if (!isValidPrefixedId(entity.idEntity, id)) {
    return invalidRequest(
      `Invalid id "${id}": expected a "${getEntityPrefix(entity.idEntity)}_"-prefixed id`
    );
  }
  const parsed = parseWrite(entity, entity.updateSchema, body);
  if (isRouteResult(parsed)) return parsed;
  const table = entity.table as any;
  const existing = await selectById(db, entity, id);
  if (existing === undefined) return notFound();

  if (
    entity.route === 'tags' &&
    typeof parsed.fields.name === 'string' &&
    (await findTagCollision(db, parsed.fields.name, id))
  ) {
    return conflict();
  }
  if (parsed.incomingMs < Date.parse(existing.updatedAt as string)) {
    return ok({ result: echo(entity, existing), applied: false, created: false });
  }
  const guarded = entity.guardMutation?.(existing, 'update', parsed.fields);
  if (guarded) return guarded;
  try {
    const updated = (await db
      .update(table)
      .set({ ...parsed.fields, updatedAt: new Date(parsed.incomingMs).toISOString() })
      .where(eq(table.id, id))
      .returning()) as Record<string, any>[];
    return ok({ result: echo(entity, updated[0]), applied: true, created: false });
  } catch (error) {
    if (isUniqueViolation(error)) return conflict();
    throw error;
  }
};

/** DELETE /{route}/:id — tombstone; absent/already-tombstoned → 404 (client ack). */
export const removeEntity = async (
  db: LocalDb,
  entity: LocalEntityConfig,
  id: string
): Promise<RouteResult> => {
  const table = entity.table as any;
  const existing = await selectById(db, entity, id);
  if (existing === undefined || existing.deletedAt) return notFound();
  const guarded = entity.guardMutation?.(existing, 'delete', {});
  if (guarded) return guarded;
  const now = new Date().toISOString();
  await db.update(table).set({ deletedAt: now, updatedAt: now }).where(eq(table.id, id));
  return ok(undefined, 204);
};
