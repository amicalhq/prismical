/**
 * Deterministic fake core sync server.
 *
 * A plain node:http server on a 127.0.0.1 ephemeral port, one instance per
 * test (started/stopped in the spec — no globals), following the fake-oauth
 * helper's conventions. It speaks the sync dialect the Legend-State client
 * depends on. The twin suite in `tests/contract/fake-sync-contract.test.ts`
 * runs the same contract assertions against this server.
 *
 * Serves ONLY `/apps/v1/me/*`: the bare `/me/*` alias is
 * being sunset server-side, so here it 404s — a client regression onto the
 * alias fails the e2e suite by construction.
 *
 * Dialect implemented (per entity store, scoped by org-user):
 *   GET    /apps/v1/me/{route}?since&includeDeleted[&includeBody] — delta list:
 *          strict-gt on updatedAt (since = epoch-ms or ISO), (updatedAt, id)
 *          ascending, tombstones only under includeDeleted=1. {success,results}.
 *   POST   /apps/v1/me/{route}          — LWW upsert: client-minted prefixed id
 *          (validated; 400 on wrong prefix), client updatedAt stored VERBATIM
 *          (absent → server now), stale → 200 {applied:false, result:<winner>},
 *          else 201/200 {applied:true, created}. createdAt backfilled. A
 *          tombstoned row can be LWW-updated but NEVER revived (delete-wins —
 *          client payloads cannot carry deletedAt, mirroring the zod strip).
 *   PUT    /apps/v1/me/{route}/:id      — partial LWW update; 404 unknown id.
 *   DELETE /apps/v1/me/{route}/:id      — tombstone (deletedAt + updatedAt
 *          bumped); {success:true}; 404 when absent or already tombstoned.
 *
 * Lane specifics:
 *   notes     — list rows carry derived per-caller fields (excerpt from the
 *               stored contentText, isOwner/canWrite true — sharing is not
 *               modeled, folderName joined from the folders store, sharedByName
 *               null); contentText appears ONLY under includeBody=1; write
 *               echoes are the RAW row (no derived fields, no contentText).
 *   tags      — names normalized like core's /me lane (strip non-alnum, cap 50,
 *               'tag' fallback); case-insensitive unique per scope → 409.
 *   note-tags — composite key (noteId, tagId): POST echo is EXACTLY
 *               {success, result:{noteId, tagId}} (no timestamps), DELETE at
 *               /:noteId/:tagId, parents must exist (404 otherwise).
 *
 * Identity: `x-org-user-id` header directly (contract tests), else a Bearer
 * token mapped via options.bearerToOrgUser (app-level e2e, paired with the
 * fake-oauth server's minted tokens). No identity → 401.
 *
 * Fault injection: `latencyMs` delays every response; `failNext(n, status)`
 * makes the next n requests fail with `status` before touching state.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { isValidPrefixedId } from '@prismical/id';

export interface RecordedSyncRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly body: Record<string, unknown> | null;
  readonly headers: Record<string, string | string[] | undefined>;
}

export interface SyncRow {
  id: string;
  updatedAt: string;
  createdAt?: string;
  deletedAt?: string | null;
  [key: string]: unknown;
}

interface EntityConfig {
  readonly route: string;
  /** @prismical/id entity name for prefix validation; null = no id validation (junction). */
  readonly idEntity: 'tag' | 'vocabulary' | 'folder' | 'note' | null;
}

const ENTITIES: readonly EntityConfig[] = [
  { route: 'tags', idEntity: 'tag' },
  { route: 'vocabulary', idEntity: 'vocabulary' },
  { route: 'folders', idEntity: 'folder' },
  { route: 'notes', idEntity: 'note' },
];

const BASE = '/apps/v1/me';
const TAG_NAME_MAX = 50;

/** Tag-name normalization for the fake sync lane: strip → cap → total fallback. */
export function fakeNormalizeTagName(name: string): string {
  let out = name.replace(/[^A-Za-z0-9]+/g, '');
  if (out.length > TAG_NAME_MAX) out = out.slice(0, TAG_NAME_MAX);
  return out.length ? out : 'tag';
}

/** Parse the timestamp forms accepted by the sync contract. */
function parseSince(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const trimmed = value.trim();
  const ms = /^[+-]?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

export interface FakeSyncOptions {
  /** Bearer token → org-user id, for app-level e2e where the app sends real auth headers. */
  readonly bearerToOrgUser?: Record<string, string>;
}

export interface FakeSyncServer {
  readonly origin: string;
  readonly requests: RecordedSyncRequest[];
  /** Seed rows directly into a scope's entity store (bypasses validation/LWW). */
  seed(orgUserId: string, route: string, rows: SyncRow[]): void;
  /** Snapshot of a scope's entity store (includes tombstones). */
  rows(orgUserId: string, route: string): SyncRow[];
  /** Fail the next `count` requests with `status` before any state change. */
  failNext(count: number, status?: number): void;
  /** Delay every response by this many ms (0 = immediate). */
  latencyMs: number;
  close(): Promise<void>;
}

export async function startFakeSyncServer(options: FakeSyncOptions = {}): Promise<FakeSyncServer> {
  // stores: orgUserId → route → id → row. Junction rows use the synthesized
  // `noteId:tagId` id internally but serve wire rows without an `id` field.
  const stores = new Map<string, Map<string, Map<string, SyncRow>>>();
  const requests: RecordedSyncRequest[] = [];
  const failures: number[] = [];
  const sockets = new Set<Socket>();
  let latencyMs = 0;

  const scopeStore = (orgUserId: string, route: string): Map<string, SyncRow> => {
    let byRoute = stores.get(orgUserId);
    if (!byRoute) stores.set(orgUserId, (byRoute = new Map()));
    let byId = byRoute.get(route);
    if (!byId) byRoute.set(route, (byId = new Map()));
    return byId;
  };

  const resolveOrgUser = (request: IncomingMessage): string | null => {
    const direct = request.headers['x-org-user-id'];
    if (typeof direct === 'string' && direct) return direct;
    const auth = request.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      return options.bearerToOrgUser?.[auth.slice('Bearer '.length)] ?? null;
    }
    return null;
  };

  const json = (response: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    const send = () => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(payload);
    };
    if (latencyMs > 0) setTimeout(send, latencyMs);
    else send();
  };

  const notFound = (response: ServerResponse): void =>
    json(response, 404, { success: false, error: { code: 'NOT_FOUND' } });

  /** Delta list over a store: strict-gt since, tombstone gate, (updatedAt, id) asc. */
  const deltaRows = (store: Map<string, SyncRow>, query: Record<string, string>): SyncRow[] => {
    const since = parseSince(query.since);
    const includeDeleted = query.includeDeleted === '1' || query.includeDeleted === 'true';
    return [...store.values()]
      .filter(row => (includeDeleted ? true : !row.deletedAt))
      .filter(row => (since === null ? true : new Date(row.updatedAt).getTime() > since))
      .sort((a, b) => {
        const ta = new Date(a.updatedAt).getTime();
        const tb = new Date(b.updatedAt).getTime();
        return ta === tb ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : ta - tb;
      });
  };

  /** Notes list-lane derived fields (the raw stored row never carries these). */
  const toNoteWireRow = (
    row: SyncRow,
    folders: Map<string, SyncRow>,
    includeBody: boolean
  ): Record<string, unknown> => {
    const { contentText, ...raw } = row;
    const folderId = typeof raw.folderId === 'string' ? raw.folderId : null;
    const folderRow = folderId ? folders.get(folderId) : undefined;
    const text = typeof contentText === 'string' ? contentText : null;
    return {
      ...raw,
      excerpt: text ? text.slice(0, 100) : null,
      folderName: folderRow && !folderRow.deletedAt ? ((folderRow.name as string) ?? null) : null,
      isOwner: true,
      canWrite: true,
      sharedByName: null,
      ...(includeBody ? { contentText: text } : {}),
    };
  };

  /** Raw write echo for notes: the stored row minus the joined body column. */
  const toNoteEchoRow = (row: SyncRow): Record<string, unknown> => {
    const { contentText: _contentText, ...raw } = row;
    return raw;
  };

  const handleGenericWrite = (
    response: ServerResponse,
    store: Map<string, SyncRow>,
    entity: EntityConfig,
    orgUserId: string,
    body: Record<string, unknown>,
    pathId: string | null // non-null ⇒ PUT (update-only)
  ): void => {
    const now = new Date().toISOString();
    const id = pathId ?? (typeof body.id === 'string' ? body.id : null);
    if (id !== null && entity.idEntity !== null && !isValidPrefixedId(entity.idEntity, id)) {
      json(response, 400, {
        success: false,
        error: { code: 'INVALID_REQUEST', message: `id must be a ${entity.idEntity} id` },
      });
      return;
    }
    const existing = id ? store.get(id) : undefined;
    if (pathId !== null && !existing) {
      notFound(response);
      return;
    }

    // Client payloads can never set/clear the tombstone or override server-owned
    // columns — mirrors the zod schemas stripping these (delete-wins invariant).
    const { id: _id, createdAt: _createdAt, deletedAt: _deletedAt, updatedAt, ...fields } = body;

    if (entity.route === 'tags' && typeof fields.name === 'string') {
      fields.name = fakeNormalizeTagName(fields.name);
      const collision = [...store.values()].find(
        row =>
          row.id !== id &&
          !row.deletedAt &&
          typeof row.name === 'string' &&
          row.name.toLowerCase() === (fields.name as string).toLowerCase()
      );
      if (collision) {
        json(response, 409, { success: false, error: { code: 'CONFLICT' } });
        return;
      }
    }

    const incomingMs =
      typeof updatedAt === 'string' || typeof updatedAt === 'number'
        ? new Date(updatedAt).getTime()
        : Date.now();
    if (existing && incomingMs < new Date(existing.updatedAt).getTime()) {
      json(response, 200, { success: true, result: existing, applied: false, created: false });
      return;
    }

    const rowId = id ?? `${entity.route}_${Math.random().toString(36).slice(2, 10)}`;
    const next: SyncRow = {
      ...(existing ?? {}),
      ...fields,
      id: rowId,
      orgUserId,
      // Client stamps are stored verbatim so the fake reproduces the server's
      // last-write-wins behavior for client clocks.
      updatedAt: new Date(incomingMs).toISOString(),
      createdAt: existing?.createdAt ?? now,
      deletedAt: existing?.deletedAt ?? null,
    };
    if (entity.route === 'notes' && !existing && typeof next.title !== 'string') {
      next.title = 'Note'; // simplified stand-in for the server's date-formatted default title
    }
    store.set(rowId, next);
    const echo = entity.route === 'notes' ? toNoteEchoRow(next) : next;
    json(response, existing ? 200 : 201, {
      success: true,
      result: echo,
      applied: true,
      created: !existing,
    });
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://fake');
      const query = Object.fromEntries(url.searchParams.entries());
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> | null = null;
      try {
        body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      requests.push({
        method: request.method ?? 'GET',
        path: url.pathname,
        query,
        body,
        headers: request.headers,
      });

      const injected = failures.shift();
      if (injected !== undefined) {
        json(response, injected, { success: false, error: { code: 'INJECTED_FAILURE' } });
        return;
      }

      // Contract anchor: ONLY the versioned prefix exists here. The bare /me/*
      // alias (or anything else) is 404 — an alias regression fails loudly.
      if (!url.pathname.startsWith(`${BASE}/`)) {
        notFound(response);
        return;
      }
      const orgUserId = resolveOrgUser(request);
      if (!orgUserId) {
        json(response, 401, { success: false, error: { code: 'UNAUTHORIZED' } });
        return;
      }

      const segments = url.pathname.slice(BASE.length + 1).split('/').filter(Boolean);
      const [route, ...rest] = segments;
      const method = request.method ?? 'GET';

      // --- note-tags junction (composite key; no LWW timestamps on echoes) ---
      if (route === 'note-tags') {
        const store = scopeStore(orgUserId, 'note-tags');
        const notes = scopeStore(orgUserId, 'notes');
        const tags = scopeStore(orgUserId, 'tags');
        if (method === 'GET' && rest.length === 0) {
          const rows = deltaRows(store, query).map(({ id: _id, orgUserId: _ou, ...wire }) => wire);
          json(response, 200, { success: true, results: rows });
          return;
        }
        if (method === 'POST' && rest.length === 0) {
          const noteId = typeof body?.noteId === 'string' ? body.noteId : null;
          const tagId = typeof body?.tagId === 'string' ? body.tagId : null;
          const noteRow = noteId ? notes.get(noteId) : undefined;
          const tagRow = tagId ? tags.get(tagId) : undefined;
          if (!noteId || !tagId || !noteRow || noteRow.deletedAt || !tagRow || tagRow.deletedAt) {
            notFound(response);
            return;
          }
          const now = new Date().toISOString();
          const key = `${noteId}:${tagId}`;
          const existing = store.get(key);
          store.set(key, {
            id: key,
            noteId,
            tagId,
            addedAt: (existing?.addedAt as string) ?? now,
            updatedAt: now,
            createdAt: existing?.createdAt ?? now,
            deletedAt: null, // link POST is an upsert-with-revive (junctions.ts)
          });
          json(response, 201, { success: true, result: { noteId, tagId } });
          return;
        }
        if (method === 'DELETE' && rest.length === 2) {
          const key = `${rest[0]}:${rest[1]}`;
          const existing = store.get(key);
          if (!existing || existing.deletedAt) {
            notFound(response);
            return;
          }
          const now = new Date().toISOString();
          store.set(key, { ...existing, deletedAt: now, updatedAt: now });
          json(response, 200, { success: true });
          return;
        }
        notFound(response);
        return;
      }

      // --- generic entity lanes (+ the notes lane's derived-field wrapping) ---
      const entity = ENTITIES.find(e => e.route === route);
      if (!entity) {
        notFound(response);
        return;
      }
      const store = scopeStore(orgUserId, entity.route);

      if (method === 'GET' && rest.length === 0) {
        const includeBody = query.includeBody === '1' || query.includeBody === 'true';
        const folders = scopeStore(orgUserId, 'folders');
        const rows = deltaRows(store, query).map(row =>
          entity.route === 'notes' ? toNoteWireRow(row, folders, includeBody) : row
        );
        json(response, 200, { success: true, results: rows });
        return;
      }
      if (method === 'POST' && rest.length === 0 && body) {
        handleGenericWrite(response, store, entity, orgUserId, body, null);
        return;
      }
      if (method === 'PUT' && rest.length === 1 && body) {
        handleGenericWrite(response, store, entity, orgUserId, body, rest[0]);
        return;
      }
      if (method === 'DELETE' && rest.length === 1) {
        const existing = store.get(rest[0]);
        if (!existing || existing.deletedAt) {
          notFound(response);
          return;
        }
        const now = new Date().toISOString();
        store.set(rest[0], { ...existing, deletedAt: now, updatedAt: now });
        json(response, 200, { success: true });
        return;
      }
      notFound(response);
    })().catch(() => {
      response.writeHead(500).end();
    });
  });

  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    requests,
    seed: (orgUserId, route, rows) => {
      const store = scopeStore(orgUserId, route);
      for (const row of rows) store.set(row.id, { deletedAt: null, ...row });
    },
    rows: (orgUserId, route) => [...scopeStore(orgUserId, route).values()],
    failNext: (count, status = 500) => {
      for (let i = 0; i < count; i += 1) failures.push(status);
    },
    get latencyMs() {
      return latencyMs;
    },
    set latencyMs(value: number) {
      latencyMs = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close(error => (error ? reject(error) : resolve()));
      }),
  };
}
