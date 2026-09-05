/* eslint-disable @typescript-eslint/no-explicit-any -- response-body assertions use `as any` for envelope ergonomics, matching the server contract suite */
/**
 * Backend-conformance suite: the same mode-neutral sync-dialect pins as
 * tests/contract/fake-sync-contract.test.ts (whose source of truth is the
 * server sync contract suite), run through the
 * WorkspaceBackendApi.request seam against BOTH backends:
 *
 *  - CloudBackendLive over the fake sync server (real HTTP, real bearer
 *    identity via bearerToOrgUser) — proving the cloud graph still speaks the
 *    dialect end to end;
 *  - LocalBackendLive over a per-test SQLite product store — proving local
 *    mode speaks the SAME dialect, envelope for envelope.
 *
 * Every scenario drives state exclusively through the dialect itself (client
 * ids minted per test, client updatedAt stamps stored verbatim), so the same
 * table runs against both. The one out-of-dialect arrangement is the note
 * BODY (owned by the collab pipeline, not sync): the harness plants it behind
 * the store (fake seed / direct row update). Response bodies are additionally
 * validated with the api-contracts zod schemas — the exact parsers app-client
 * runs in production.
 *
 * Deliberately NOT here (fake-vs-server or fake-only concerns): default note
 * titles (the server date-formats, the fake stubs 'Note', local uses
 * 'Untitled note' — never pinned cross-backend), fault injection, the bare
 * /me/* alias, auth failures. Local-only queryFilter reads sit in their own
 * describe at the bottom (the fake does not implement those routes).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { eq } from 'drizzle-orm';
import { Context, Effect, Layer, Scope } from 'effect';
import type { TransportRequest, TransportResponse } from '@prismical/desktop-contracts';
import {
  NoteTagResponseSchema,
  SyncDeleteResponseSchema,
  SyncListResponseSchema,
  SyncWriteResponseSchema,
} from '@prismical/api-contracts/apps/v1';
import { createId } from '@prismical/id';
import { startFakeSyncServer } from '../../e2e/helpers/fake-sync';
import { fakeAiProviderLayer } from '../helpers/fake-workspace-env';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import { LocalBackendLive } from '../../src/main/domains/local-backend/live';
import { CloudBackendLive, WorkspaceTransportLive } from '../../src/main/domains/transport/live';
import { WorkspaceBackend, type WorkspaceBackendApi } from '../../src/main/domains/transport/service';
import { makeProductDbLayer } from '../../src/main/infra/product-db/live';
import * as schema from '../../src/main/infra/product-db/schema';
import { ProductDb } from '../../src/main/infra/product-db/service';
import { SignedInSession } from '../../src/main/runtime/workspace-layer';

const BASE = '/apps/v1/me';
const OU = 'ou_conformance';
const BEARER = 'idtoken-conformance';

interface BackendHarness {
  readonly api: WorkspaceBackendApi;
  /** Plant plain body text behind an EXISTING note (the collab pipeline's job, not the dialect's). */
  readonly setNoteBody: (noteId: string, contentText: string) => Effect.Effect<void>;
}

interface BackendFactory {
  readonly name: string;
  /** Scoped acquire: yields the api; the scope releases the server/store. */
  readonly make: Effect.Effect<BackendHarness, never, Scope.Scope>;
}

const cloudFactory: BackendFactory = {
  name: 'CloudBackendLive + fake-sync',
  make: Effect.gen(function* () {
    const fake = yield* Effect.acquireRelease(
      Effect.promise(() => startFakeSyncServer({ bearerToOrgUser: { [BEARER]: OU } })),
      server => Effect.promise(() => server.close())
    );
    const logger = makeTestLogger();
    const env = Layer.mergeAll(
      testConfigLayer({
        endpoints: {
          coreApiUrl: fake.origin,
          noteWsUrl: 'wss://note.test/collaboration',
          webAppOrigin: 'https://app.test',
          analyticsKey: null,
          analyticsHost: null,
        },
      }),
      logger.layer,
      WorkspaceTransportLive,
      Layer.succeed(SignedInSession, {
        pinned: { sub: 'user_conformance', email: 'conformance@example.com' },
        idToken: Effect.succeed(BEARER),
      })
    );
    const ctx = yield* Layer.build(CloudBackendLive.pipe(Layer.provide(env)));
    return {
      api: Context.get(ctx, WorkspaceBackend),
      setNoteBody: (noteId, contentText) =>
        Effect.sync(() => {
          const row = fake.rows(OU, 'notes').find(candidate => candidate.id === noteId);
          if (!row) throw new Error(`setNoteBody: unknown note ${noteId}`);
          fake.seed(OU, 'notes', [{ ...row, contentText }]);
        }),
    };
  }),
};

// A temp dir per test FILE, a distinct db per test — WAL siblings isolated,
// parallel forks never contend (operational-db idiom).
const tempDir = mkdtempSync(path.join(tmpdir(), 'prismical-conformance-test-'));
let dbSeq = 0;

const localFactory: BackendFactory = {
  name: 'LocalBackendLive + product-db',
  make: Effect.gen(function* () {
    dbSeq += 1;
    const logger = makeTestLogger();
    const env = Layer.mergeAll(
      testConfigLayer({ localDbPath: path.join(tempDir, `conformance-${dbSeq}.db`) }),
      logger.layer,
      WorkspaceTransportLive,
      fakeAiProviderLayer()
    );
    const productDb = makeProductDbLayer({ kind: 'local' });
    const ctx = yield* Layer.build(
      Layer.mergeAll(productDb, LocalBackendLive.pipe(Layer.provide(productDb))).pipe(
        Layer.provide(env)
      )
    ).pipe(Effect.orDie);
    const product = Context.get(ctx, ProductDb);
    return {
      api: Context.get(ctx, WorkspaceBackend),
      setNoteBody: (noteId, contentText) =>
        Effect.promise(async () => {
          await product.db
            .update(schema.note)
            .set({ contentText })
            .where(eq(schema.note.id, noteId));
        }),
    };
  }),
};

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

const expectOk = (res: TransportResponse, status?: number): { status: number; bodyJson: any } => {
  assert.isTrue('ok' in res && res.ok, `expected the ok arm, got ${JSON.stringify(res)}`);
  const okRes = res as Extract<TransportResponse, { ok: true }>;
  if (status !== undefined) {
    assert.strictEqual(okRes.status, status, JSON.stringify(okRes.bodyJson));
  }
  return okRes as { status: number; bodyJson: any };
};

const statusOf = (res: TransportResponse): number => {
  assert.isTrue('ok' in res && res.ok, `expected the ok arm, got ${JSON.stringify(res)}`);
  return (res as Extract<TransportResponse, { ok: true }>).status;
};

/** Zod-validated list pull — the exact parser app-client runs. */
const listOf = (res: TransportResponse): Record<string, any>[] =>
  SyncListResponseSchema.parse(expectOk(res, 200).bodyJson).results as Record<string, any>[];

const request = (api: WorkspaceBackendApi, req: TransportRequest) => api.request(req);

const get = (api: WorkspaceBackendApi, path: string, query?: Record<string, string>) =>
  request(api, { method: 'GET', path, ...(query === undefined ? {} : { query }) });
const post = (api: WorkspaceBackendApi, path: string, body: unknown) =>
  request(api, { method: 'POST', path, body });
const put = (api: WorkspaceBackendApi, path: string, body: unknown) =>
  request(api, { method: 'PUT', path, body });
const del = (api: WorkspaceBackendApi, path: string) => request(api, { method: 'DELETE', path });

const T1 = '2030-01-01T00:00:00.000Z';
const T2 = '2030-01-02T00:00:00.000Z';

// ---------------------------------------------------------------------------
// The shared, mode-neutral dialect table
// ---------------------------------------------------------------------------

for (const factory of [cloudFactory, localFactory]) {
  describe(`sync-dialect conformance — ${factory.name}`, () => {
    describe('delta list', () => {
      it.effect('since is STRICT gt (ISO)', () =>
        Effect.gen(function* () {
          const { api } = yield* factory.make;
          const idA = createId('tag');
          const idB = createId('tag');
          yield* post(api, `${BASE}/tags`, { id: idA, name: 'DeltaA', color: '#111', updatedAt: T1 });
          yield* post(api, `${BASE}/tags`, { id: idB, name: 'DeltaB', color: '#222', updatedAt: T2 });
          const ids = listOf(yield* get(api, `${BASE}/tags`, { since: T1 })).map(r => r.id);
          assert.include(ids, idB);
          assert.notInclude(ids, idA);
        }).pipe(Effect.scoped)
      );

      it.effect('since accepts epoch-ms', () =>
        Effect.gen(function* () {
          const { api } = yield* factory.make;
          const idA = createId('tag');
          const idB = createId('tag');
          yield* post(api, `${BASE}/tags`, { id: idA, name: 'EpochA', color: '#111', updatedAt: T1 });
          yield* post(api, `${BASE}/tags`, { id: idB, name: 'EpochB', color: '#222', updatedAt: T2 });
          const ids = listOf(
            yield* get(api, `${BASE}/tags`, { since: String(new Date(T1).getTime()) })
          ).map(r => r.id);
          assert.include(ids, idB);
          assert.notInclude(ids, idA);
        }).pipe(Effect.scoped)
      );

      it.effect('envelope {results} ordered (updatedAt, id) — zod-parsed', () =>
        Effect.gen(function* () {
          const { api } = yield* factory.make;
          const idA = createId('tag');
          const idB = createId('tag');
          const idC = createId('tag');
          // Two rows share a stamp (id tie-break), one is later.
          yield* post(api, `${BASE}/tags`, {
            id: idA,
            name: 'OrderA',
            color: '#111',
            updatedAt: T1,
          });
          yield* post(api, `${BASE}/tags`, {
            id: idB,
            name: 'OrderB',
            color: '#222',
            updatedAt: T1,
          });
          yield* post(api, `${BASE}/tags`, {
            id: idC,
            name: 'OrderC',
            color: '#333',
            updatedAt: T2,
          });
          const res = expectOk(yield* get(api, `${BASE}/tags`), 200);
          assert.notProperty(res.bodyJson, 'success');
          const results = SyncListResponseSchema.parse(res.bodyJson).results as Record<
            string,
            any
          >[];
          const mine = results.filter(r => [idA, idB, idC].includes(r.id as string));
          assert.deepStrictEqual(
            mine.map(r => r.id),
            [...[idA, idB].sort(), idC]
          );
        }).pipe(Effect.scoped)
      );
    });

    describe('writes', () => {
      it.effect('PUT on an unknown id is 404', () =>
        Effect.gen(function* () {
          const { api } = yield* factory.make;
          const res = yield* put(api, `${BASE}/tags/${createId('tag')}`, {
            name: 'Ghost',
            color: '#333',
          });
          assert.strictEqual(statusOf(res), 404);
        }).pipe(Effect.scoped)
      );

      it.effect('POST persists a client-minted id verbatim, 201, createdAt backfilled — zod-parsed', () =>
        Effect.gen(function* () {
          const { api } = yield* factory.make;
          const id = createId('tag');
          const res = expectOk(yield* post(api, `${BASE}/tags`, { id, name: 'Mint', color: '#444' }), 201);
          const body = SyncWriteResponseSchema.parse(res.bodyJson);
          assert.notProperty(body, 'success');
          assert.strictEqual(body.applied, true);
          assert.strictEqual(body.created, true);
          assert.strictEqual((body.result as any).id, id);
          assert.isOk((body.result as any).createdAt);
        }).pipe(Effect.scoped)
      );

      it.effect('POST with a foreign entity prefix is 400', () =>
        Effect.gen(function* () {
          const { api } = yield* factory.make;
          const res = yield* post(api, `${BASE}/vocabulary`, { id: createId('note'), word: 'w' });
          assert.strictEqual(statusOf(res), 400);
        }).pipe(Effect.scoped)
      );

      it.effect('stale write → 200 applied:false + server-winning row', () =>
        Effect.gen(function* () {
          const { api } = yield* factory.make;
          const id = createId('tag');
          yield* post(api, `${BASE}/tags`, { id, name: 'Fresh', color: '#555', updatedAt: T2 });
          const res = expectOk(
            yield* post(api, `${BASE}/tags`, { id, name: 'Stale', color: '#000', updatedAt: T1 }),
            200
          );
          const body = SyncWriteResponseSchema.parse(res.bodyJson);
          assert.strictEqual(body.applied, false);
          assert.strictEqual((body.result as any).name, 'Fresh');
        }).pipe(Effect.scoped)
      );

      it.effect('partial PUT keeps unsent fields', () =>
        Effect.gen(function* () {
          const { api } = yield* factory.make;
          const id = createId('tag');
          yield* post(api, `${BASE}/tags`, { id, name: 'Part', color: '#666' });
          const res = expectOk(yield* put(api, `${BASE}/tags/${id}`, { name: 'PartB' }), 200);
          assert.strictEqual(res.bodyJson.result.color, '#666');
          assert.strictEqual(res.bodyJson.result.name, 'PartB');
        }).pipe(Effect.scoped)
      );

      it.effect('tag-name is normalized on the way in; case-insensitive collision is 409', () =>
        Effect.gen(function* () {
          const { api } = yield* factory.make;
          const res = expectOk(
            yield* post(api, `${BASE}/tags`, { id: createId('tag'), name: 'My Work!', color: '#777' }),
            201
          );
          assert.strictEqual(res.bodyJson.result.name, 'MyWork');
          const collide = yield* post(api, `${BASE}/tags`, {
            id: createId('tag'),
            name: 'mywork',
            color: '#888',
          });
          assert.strictEqual(statusOf(collide), 409);
        }).pipe(Effect.scoped)
      );
    });

    describe('tombstones', () => {
      it.effect(
        'DELETE is exactly HTTP 204; hidden live; includeDeleted shows the bumped stamp',
        () =>
          Effect.gen(function* () {
            const { api } = yield* factory.make;
            const id = createId('tag');
            // Server-now stamp, like a real create.
            yield* post(api, `${BASE}/tags`, { id, name: 'Tomb', color: '#999' });
            const preDelete = Date.parse(
              listOf(yield* get(api, `${BASE}/tags`, { includeDeleted: '1' })).find(
                r => r.id === id
              )!.updatedAt as string
            );
            const delRes = expectOk(yield* del(api, `${BASE}/tags/${id}`), 204);
            assert.deepStrictEqual(SyncDeleteResponseSchema.parse(delRes.bodyJson), undefined);
            assert.deepStrictEqual(delRes.bodyJson, undefined);

            const live = listOf(yield* get(api, `${BASE}/tags`)).map(r => r.id);
            assert.notInclude(live, id);

            const tomb = listOf(yield* get(api, `${BASE}/tags`, { includeDeleted: '1' })).find(
              r => r.id === id
            )!;
            assert.isOk(tomb.deletedAt);
            // The bump carries the delete past cursors ≥ the live row's stamp.
            assert.isAtLeast(Date.parse(tomb.updatedAt as string), preDelete);
          }).pipe(Effect.scoped)
      );

      it.effect('re-DELETE is 404 (client ack)', () =>
        Effect.gen(function* () {
          const { api } = yield* factory.make;
          const id = createId('tag');
          yield* post(api, `${BASE}/tags`, { id, name: 'Twice', color: '#aaa' });
          assert.strictEqual(statusOf(yield* del(api, `${BASE}/tags/${id}`)), 204);
          assert.strictEqual(statusOf(yield* del(api, `${BASE}/tags/${id}`)), 404);
        }).pipe(Effect.scoped)
      );

      it.effect('a tombstoned row can be LWW-updated but never revived (delete-wins)', () =>
        Effect.gen(function* () {
          const { api } = yield* factory.make;
          const id = createId('tag');
          yield* post(api, `${BASE}/tags`, { id, name: 'Dead', color: '#bbb' });
          yield* del(api, `${BASE}/tags/${id}`);
          yield* post(api, `${BASE}/tags`, { id, name: 'Zombie', color: '#ccc' });
          const tomb = listOf(yield* get(api, `${BASE}/tags`, { includeDeleted: '1' })).find(
            r => r.id === id
          )!;
          assert.isOk(tomb.deletedAt); // still dead
          assert.strictEqual(tomb.name, 'Zombie'); // but the LWW fields applied
        }).pipe(Effect.scoped)
      );
    });

    describe('notes lane', () => {
      it.effect('list rows carry derived fields, excerpt from body, folderName joined — no contentText by default', () =>
        Effect.gen(function* () {
          const harness = yield* factory.make;
          const { api } = harness;
          const noteId = createId('note');
          const folderId = createId('folder');
          yield* post(api, `${BASE}/folders`, { id: folderId, name: 'Contract Folder' });
          yield* post(api, `${BASE}/notes`, { id: noteId, title: 'Contract Note', folderId });
          yield* harness.setNoteBody(noteId, 'body text for the excerpt derivation check');
          const row = listOf(yield* get(api, `${BASE}/notes`)).find(r => r.id === noteId)!;
          assert.strictEqual(row.excerpt, 'body text for the excerpt derivation check');
          assert.strictEqual(row.folderName, 'Contract Folder');
          assert.strictEqual(row.isOwner, true);
          assert.strictEqual(row.canWrite, true);
          assert.strictEqual(row.sharedByName, null);
          assert.notProperty(row, 'contentText');
        }).pipe(Effect.scoped)
      );

      it.effect('includeBody=1 adds contentText and composes with since', () =>
        Effect.gen(function* () {
          const harness = yield* factory.make;
          const { api } = harness;
          const noteId = createId('note');
          yield* post(api, `${BASE}/notes`, { id: noteId, title: 'Body Note' });
          yield* harness.setNoteBody(noteId, 'the full body text');
          const row = listOf(yield* get(api, `${BASE}/notes`, { includeBody: '1' })).find(
            r => r.id === noteId
          )!;
          assert.strictEqual(row.contentText, 'the full body text');
          const later = listOf(
            yield* get(api, `${BASE}/notes`, {
              includeBody: '1',
              since: new Date('2099-01-01').toISOString(),
            })
          );
          assert.deepStrictEqual(later, []);
        }).pipe(Effect.scoped)
      );

      it.effect('write echo is the RAW row — no derived fields, no contentText', () =>
        Effect.gen(function* () {
          const { api } = yield* factory.make;
          const id = createId('note');
          const res = expectOk(yield* post(api, `${BASE}/notes`, { id, title: 'Echo' }), 201);
          const echoed = SyncWriteResponseSchema.parse(res.bodyJson).result as Record<string, any>;
          assert.notProperty(echoed, 'excerpt');
          assert.notProperty(echoed, 'canWrite');
          assert.notProperty(echoed, 'isOwner');
          assert.notProperty(echoed, 'contentText');
        }).pipe(Effect.scoped)
      );
    });

    describe('note-tags junction', () => {
      it.effect('link to a missing parent is 404', () =>
        Effect.gen(function* () {
          const { api } = yield* factory.make;
          const tId = createId('tag');
          yield* post(api, `${BASE}/tags`, { id: tId, name: 'JTag', color: '#ddd' });
          const res = yield* post(api, `${BASE}/note-tags`, { noteId: createId('note'), tagId: tId });
          assert.strictEqual(statusOf(res), 404);
        }).pipe(Effect.scoped)
      );

      it.effect('POST echo carries ONLY {noteId, tagId} — zod-parsed', () =>
        Effect.gen(function* () {
          const { api } = yield* factory.make;
          const nId = createId('note');
          const tId = createId('tag');
          yield* post(api, `${BASE}/notes`, { id: nId, title: 'J' });
          yield* post(api, `${BASE}/tags`, { id: tId, name: 'JEcho', color: '#ddd' });
          const res = expectOk(yield* post(api, `${BASE}/note-tags`, { noteId: nId, tagId: tId }), 201);
          assert.deepStrictEqual(res.bodyJson, { noteId: nId, tagId: tId });
          NoteTagResponseSchema.parse(res.bodyJson);
        }).pipe(Effect.scoped)
      );

      it.effect('delta list supports since + includeDeleted; rows carry updatedAt and no id', () =>
        Effect.gen(function* () {
          const { api } = yield* factory.make;
          const nId = createId('note');
          const tId = createId('tag');
          yield* post(api, `${BASE}/notes`, { id: nId, title: 'JL' });
          yield* post(api, `${BASE}/tags`, { id: tId, name: 'JList', color: '#dde' });
          yield* post(api, `${BASE}/note-tags`, { noteId: nId, tagId: tId });
          const rows = listOf(
            yield* get(api, `${BASE}/note-tags`, {
              includeDeleted: '1',
              since: new Date('2000-01-01').toISOString(),
            })
          );
          const row = rows.find(r => r.noteId === nId && r.tagId === tId)!;
          assert.isOk(row.updatedAt);
          assert.notProperty(row, 'id');
        }).pipe(Effect.scoped)
      );

      it.effect('unlink HTTP 204; replay 404; re-POST revives the link', () =>
        Effect.gen(function* () {
          const { api } = yield* factory.make;
          const nId = createId('note');
          const tId = createId('tag');
          yield* post(api, `${BASE}/notes`, { id: nId, title: 'JU' });
          yield* post(api, `${BASE}/tags`, { id: tId, name: 'JRevive', color: '#ddf' });
          yield* post(api, `${BASE}/note-tags`, { noteId: nId, tagId: tId });

          const first = expectOk(yield* del(api, `${BASE}/note-tags/${nId}/${tId}`), 204);
          assert.deepStrictEqual(first.bodyJson, undefined);
          assert.strictEqual(statusOf(yield* del(api, `${BASE}/note-tags/${nId}/${tId}`)), 404);

          // The junction POST is the dialect's ONE revive: the link comes back live.
          const revived = expectOk(
            yield* post(api, `${BASE}/note-tags`, { noteId: nId, tagId: tId }),
            201
          );
          assert.deepStrictEqual(revived.bodyJson, { noteId: nId, tagId: tId });
          const live = listOf(yield* get(api, `${BASE}/note-tags`)).find(
            r => r.noteId === nId && r.tagId === tId
          )!;
          assert.isNotOk(live.deletedAt);
        }).pipe(Effect.scoped)
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Local-only extras: queryFilter reads the fake does not implement
// ---------------------------------------------------------------------------

describe('local-only sync lanes — LocalBackendLive', () => {
  it.effect('recordings supports the ?noteId= filter', () =>
    Effect.gen(function* () {
      const { api } = yield* localFactory.make;
      const noteA = createId('note');
      const noteB = createId('note');
      const recA = createId('recording');
      const recB = createId('recording');
      yield* post(api, `${BASE}/recordings`, {
        id: recA,
        title: 'Take A',
        captureMode: 'mic',
        noteId: noteA,
      });
      yield* post(api, `${BASE}/recordings`, {
        id: recB,
        title: 'Take B',
        captureMode: 'mic',
        noteId: noteB,
      });
      const rows = listOf(yield* get(api, `${BASE}/recordings`, { noteId: noteA }));
      assert.deepStrictEqual(
        rows.map(r => r.id),
        [recA]
      );
    }).pipe(Effect.scoped)
  );

  it.effect('transcript-segments supports the ?recordingId= filter', () =>
    Effect.gen(function* () {
      const { api } = yield* localFactory.make;
      const recA = createId('recording');
      const recB = createId('recording');
      const segA = createId('transcriptSegment');
      const segB = createId('transcriptSegment');
      const segment = (id: string, recordingId: string) => ({
        id,
        recordingId,
        source: 'mic',
        speaker: 'you',
        text: 'hello',
        startTimeMs: 0,
        endTimeMs: 1000,
        segmentOrder: 0,
      });
      yield* post(api, `${BASE}/transcript-segments`, segment(segA, recA));
      yield* post(api, `${BASE}/transcript-segments`, segment(segB, recB));
      const rows = listOf(yield* get(api, `${BASE}/transcript-segments`, { recordingId: recB }));
      assert.deepStrictEqual(
        rows.map(r => r.id),
        [segB]
      );
    }).pipe(Effect.scoped)
  );
});
