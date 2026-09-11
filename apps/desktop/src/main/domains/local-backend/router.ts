/**
 * The local /apps/v1/me router parses and dispatches one
 * TransportRequest onto the lane handlers. Route coverage mirrors what the
 * shared renderer stack actually calls in local mode:
 *
 *  - FULL sync dialect: notes, folders, tags, vocabulary, note-tags,
 *    recordings, transcript-segments, artifacts, skills (system rows
 *    seeded, user skills over the same 4-route dialect);
 *  - the AI lanes: /search (FTS5), /skills/:id/run, /skill-runs/accept
 *    + /restore, /enhanced-recordings, /title-runs/apply + /undo,
 *    /ask/conversations, /instances (+ /:id/models), /model-defaults —
 *    served from the product store + AiProvider; POST /ask itself is the
 *    stream lane (LocalBackendLive.openAskStream), never a unary request;
 *  - GET-empty lists for the cloud-only/deferred lanes the shell polls
 *    (calendars, events, recording-speakers, note-generation-audits,
 *    team-vocabulary) — `{results:[]}` keeps their consumers in
 *    clean empty states instead of error states;
 *  - organizations/profile from the LOCAL_WORKSPACE constants, as a list
 *    ({results}) and a direct profile respectively, matching
 *    OrganizationsResponseSchema/ViewerProfileResponseSchema);
 *  - anything else → 404 with fake-sync's NOT_FOUND body (a deterministic
 *    4xx: react-query renders an error/empty state and never retries it).
 *
 * Only the versioned prefix exists — the transport allowlist
 * already pins it, the double-check here is defense in depth.
 */
import type { LogMetadata } from '../../infra/logging/service';
import type Database from 'better-sqlite3';
import {
  LOCAL_FEATURE_FLAGS,
  LOCAL_WORKSPACE,
  TRANSPORT_PATH_PREFIX,
} from '@prismical/desktop-contracts';
import type { TransportRequest } from '@prismical/desktop-contracts';
import type { LocalAiPort } from './ai-port';
import { getModelDefaults, instanceModels, listInstances, setModelDefault } from './ai-routes';
import { askConversations } from './ask';
import { createNoteTag, deleteNoteTag, listNoteTags } from './junctions';
import { createNote, listNotes, removeNote, updateNote } from './notes';
import { getLocalPreferences, writeLocalPreferences } from './preferences';
import { handleSearch } from './search';
import { pendingSkillResults, resolveSkillResult } from './skill-recovery';
import {
  acceptSkillRun,
  enhancedRecordings,
  listSkills,
  localSkillAvailable,
  restoreSkillRun,
  runSkill,
  SKILL_ENTITY,
  titleRun,
} from './skills';
import {
  LOCAL_SYNC_ENTITIES,
  listEntity,
  removeEntity,
  updateEntity,
  upsertEntity,
} from './sync-entities';
import { notFound, ok, type LocalDb, type RouteResult } from './wire';

/** Everything a route handler may reach — built once per local workspace by LocalBackendLive. */
export interface LocalRouteContext {
  readonly db: LocalDb;
  /** The raw better-sqlite3 handle — FTS5 MATCH queries are outside drizzle's schema. */
  readonly client: Database.Database;
  readonly ai: LocalAiPort;
  readonly locale: string;
  readonly log: (message: string, data?: LogMetadata['context']) => void;
  /**
   * The workspace's single title-run writer: apply/undo read-compare-write a
   * note's titleRevision. One process, one lock — the lanes cannot interleave.
   */
  readonly titleLock: <T>(work: () => Promise<T>) => Promise<T>;
  readonly recoverableRuns: Map<string, Promise<RouteResult>>;
}

/** Cloud-only/deferred lanes served as permanently-empty lists in local mode. */
const EMPTY_LIST_ROUTES: ReadonlySet<string> = new Set([
  'calendars',
  'events',
  'recording-speakers',
  'note-generation-audits',
  'team-vocabulary',
]);

/**
 * The single local org row (role owner, one member). `features` is the local
 * feature-flag table: the renderer's capability port hands the
 * SAME table to useFeatureFlag, and query-cache readers (the auto-pause policy)
 * read it off this row — one source, two lanes.
 */
const LOCAL_ORGANIZATION = {
  orgUserId: LOCAL_WORKSPACE.orgUserId,
  orgId: LOCAL_WORKSPACE.orgId,
  name: LOCAL_WORKSPACE.orgName,
  slug: LOCAL_WORKSPACE.orgSlug,
  role: 'owner',
  allowPublicSharing: false,
  features: LOCAL_FEATURE_FLAGS,
  memberCount: 1,
} as const;

const LOCAL_PROFILE = {
  id: LOCAL_WORKSPACE.sub,
  email: LOCAL_WORKSPACE.email,
  name: LOCAL_WORKSPACE.name,
  image: null,
} as const;

const ALL_SYNC_ENTITIES = [...LOCAL_SYNC_ENTITIES, SKILL_ENTITY];

/** One completed local exchange per request — never throws for expected conditions. */
export const handleLocalRequest = async (
  ctx: LocalRouteContext,
  req: TransportRequest
): Promise<RouteResult> => {
  // Some callers inline the query string into the path (the client's
  // `DELETE /me/model-defaults?useCase=…`); core's HTTP layer splits it, so
  // the local router must too.
  const [rawPath = '', rawQuery] = req.path.split('?', 2);
  if (rawPath !== TRANSPORT_PATH_PREFIX && !rawPath.startsWith(`${TRANSPORT_PATH_PREFIX}/`)) {
    return notFound();
  }
  const segments = rawPath
    .slice(TRANSPORT_PATH_PREFIX.length)
    .split('/')
    .filter(segment => segment.length > 0);
  const [route, ...rest] = segments;
  // The bare GET /apps/v1/me bootstrap is not part of the local surface.
  if (route === undefined) return notFound();
  const method = req.method;
  const query: Record<string, string> = {
    ...Object.fromEntries(new URLSearchParams(rawQuery ?? '')),
    ...(req.query ?? {}),
  };
  const { db, client, ai } = ctx;

  if (route === 'organizations') {
    return method === 'GET' && rest.length === 0 ? ok({ results: [LOCAL_ORGANIZATION] }) : notFound();
  }
  if (route === 'profile') {
    return method === 'GET' && rest.length === 0 ? ok(LOCAL_PROFILE) : notFound();
  }
  if (route === 'preferences') {
    if (rest.length !== 0) return notFound();
    if (method === 'GET') return ok(getLocalPreferences(db));
    if (method === 'POST' || method === 'PATCH') return writeLocalPreferences(db, method, req.body);
    return notFound();
  }
  if (EMPTY_LIST_ROUTES.has(route)) {
    return method === 'GET' && rest.length === 0 ? ok({ results: [] }) : notFound();
  }

  if (route === 'notes') {
    if (method === 'GET' && rest.length === 0) return listNotes(db, query);
    if (method === 'POST' && rest.length === 0) return createNote(db, req.body);
    if (method === 'PUT' && rest.length === 1) return updateNote(db, rest[0], req.body);
    if (method === 'DELETE' && rest.length === 1) return removeNote(db, rest[0]);
    return notFound();
  }

  if (route === 'note-tags') {
    if (method === 'GET' && rest.length === 0) return listNoteTags(db, query);
    if (method === 'POST' && rest.length === 0) return createNoteTag(db, req.body);
    if (method === 'DELETE' && rest.length === 2) return deleteNoteTag(db, rest[0], rest[1]);
    return notFound();
  }

  // ── AI lanes ──
  if (route === 'skills') {
    // Reject before sync's stale-write echo can expose a gated row.
    const skillId = rest[0] ??
      (method === 'POST' && typeof req.body === 'object' && req.body !== null && 'id' in req.body
        ? req.body.id
        : undefined);
    if (!localSkillAvailable(skillId)) return notFound();
    if (method === 'GET' && rest.length === 0) return listSkills(db, query);
  }
  if (route === 'search') {
    return method === 'GET' && rest.length === 0 ? handleSearch(client, query) : notFound();
  }
  if (route === 'skills' && rest.length === 2 && rest[1] === 'run') {
    return method === 'POST'
      ? runSkill({ db, ai, locale: ctx.locale, log: ctx.log, recoverableRuns: ctx.recoverableRuns }, rest[0]!, req.body)
      : notFound();
  }
  if (route === 'skill-runs' && rest.length === 1) {
    if (method === 'GET' && rest[0] === 'pending') return pendingSkillResults(db, query);
    if (method === 'POST' && rest[0] === 'resolve') return resolveSkillResult(db, req.body);
    if (method === 'POST' && rest[0] === 'accept') return acceptSkillRun(db, req.body);
    if (method === 'POST' && rest[0] === 'restore') return restoreSkillRun(db, req.body);
    return notFound();
  }
  if (route === 'enhanced-recordings') {
    return method === 'GET' && rest.length === 0 ? enhancedRecordings(db, query) : notFound();
  }
  if (route === 'title-runs' && rest.length === 1 && method === 'POST') {
    if (rest[0] === 'apply') return ctx.titleLock(() => titleRun(db, false, req.body));
    if (rest[0] === 'undo') return ctx.titleLock(() => titleRun(db, true, req.body));
    return notFound();
  }
  if (route === 'ask') {
    return method === 'GET' && rest.length === 1 && rest[0] === 'conversations'
      ? askConversations(db)
      : notFound();
  }
  if (route === 'instances') {
    if (method === 'GET' && rest.length === 0) return listInstances(ai);
    if (method === 'GET' && rest.length === 2 && rest[1] === 'models') {
      return instanceModels(ai, rest[0]!);
    }
    return notFound();
  }
  if (route === 'model-defaults' && rest.length === 0) {
    if (method === 'GET') return getModelDefaults(ai);
    if (method === 'PUT') return setModelDefault(ai, req.body);
    if (method === 'DELETE') return ok(undefined, 204);
    return notFound();
  }

  const entity = ALL_SYNC_ENTITIES.find(candidate => candidate.route === route);
  if (entity !== undefined) {
    if (method === 'GET' && rest.length === 0) return listEntity(db, entity, query);
    if (method === 'POST' && rest.length === 0) return upsertEntity(db, entity, req.body);
    if (method === 'PUT' && rest.length === 1) return updateEntity(db, entity, rest[0], req.body);
    if (method === 'DELETE' && rest.length === 1) return removeEntity(db, entity, rest[0]);
  }
  return notFound();
};
