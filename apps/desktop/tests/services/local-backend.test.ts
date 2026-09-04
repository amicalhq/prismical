/* eslint-disable @typescript-eslint/no-explicit-any -- response-body assertions use `as any` for envelope ergonomics, matching the contract suites */
/**
 * LocalBackendLive unit tests — the local-only behaviors the
 * cross-backend conformance suite (tests/contract/backend-conformance.test.ts)
 * cannot pin:
 *  - the LEGACY organizations/profile envelopes built from LOCAL_WORKSPACE
 *    (validated against the api-contracts zod schemas the shell parses with),
 *  - GET-empty lanes, unknown-route 404s, and the failure→INTERNAL fold,
 *  - the thin recording-lane acks + the cloud-concept lanes failing typed,
 *  - register/deregister into the boot-scoped WorkspaceTransport,
 *  - notes title semantics (default title, manual rename revisions, empty-
 *    string reset with firstLine follow) and updatedAt monotonicity.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { eq } from 'drizzle-orm';
import { Cause, Context, Effect, Exit, Layer, Option, Scope } from 'effect';
import type { TransportResponse } from '@prismical/desktop-contracts';
import { LOCAL_FEATURE_FLAGS, LOCAL_WORKSPACE } from '@prismical/desktop-contracts';
import {
  OrganizationsResponseSchema,
  ViewerProfileResponseSchema,
} from '@prismical/api-contracts/apps/v1';
import { createId } from '@prismical/id';
import { fakeAiProviderLayer } from '../helpers/fake-workspace-env';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import { SYSTEM_SKILLS } from '@prismical/ai-prompts';
import { AuthStateError } from '../../src/main/domains/auth/service';
import { LocalBackendLive } from '../../src/main/domains/local-backend/live';
import { describeDbError, isUniqueViolation } from '../../src/main/domains/local-backend/wire';
import { WorkspaceTransportLive } from '../../src/main/domains/transport/live';
import {
  WorkspaceBackend,
  WorkspaceTransport,
} from '../../src/main/domains/transport/service';
import { makeProductDbLayer } from '../../src/main/infra/product-db/live';
import * as schema from '../../src/main/infra/product-db/schema';
import { ProductDb } from '../../src/main/infra/product-db/service';

// A temp dir per test file keeps WAL siblings isolated (operational-db idiom).
const tempDir = mkdtempSync(path.join(tmpdir(), 'prismical-local-backend-test-'));
let dbSeq = 0;

/** Build the backend graph over a fresh file-backed product store. */
const buildBackend = Effect.gen(function* () {
  dbSeq += 1;
  const logger = makeTestLogger();
  const env = Layer.mergeAll(
    testConfigLayer({ localDbPath: path.join(tempDir, `local-backend-${dbSeq}.db`) }),
    logger.layer,
    WorkspaceTransportLive,
    fakeAiProviderLayer()
  );
  const scope = yield* Scope.make();
  const envCtx = yield* Layer.build(env).pipe(Scope.extend(scope));
  const productDb = makeProductDbLayer({ kind: 'local' });
  const workspace = Layer.mergeAll(productDb, LocalBackendLive.pipe(Layer.provide(productDb)));
  const ctx = yield* Layer.build(workspace).pipe(
    Effect.provide(envCtx),
    Scope.extend(scope),
    Effect.orDie
  );
  return {
    logger,
    scope,
    api: Context.get(ctx, WorkspaceBackend),
    product: Context.get(ctx, ProductDb),
    transport: Context.get(envCtx, WorkspaceTransport),
  };
});

const expectOk = (res: TransportResponse, status?: number): { status: number; bodyJson: any } => {
  assert.isTrue('ok' in res && res.ok, `expected the ok arm, got ${JSON.stringify(res)}`);
  const okRes = res as Extract<TransportResponse, { ok: true }>;
  if (status !== undefined) {
    assert.strictEqual(okRes.status, status, JSON.stringify(okRes.bodyJson));
  }
  return okRes as { status: number; bodyJson: any };
};

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.failureOption(exit.cause)) : undefined;

describe('LocalBackendLive', () => {
  it.effect('organizations: LEGACY {results} envelope built from LOCAL_WORKSPACE', () =>
    Effect.gen(function* () {
      const { api, scope } = yield* buildBackend;
      const res = expectOk(
        yield* api.request({ method: 'GET', path: '/apps/v1/me/organizations' }),
        200
      );
      // The shell parses this with the legacy schema (NO success field).
      assert.notProperty(res.bodyJson, 'success');
      const parsed = OrganizationsResponseSchema.parse(res.bodyJson);
      assert.deepStrictEqual(parsed.results, [
        {
          orgUserId: LOCAL_WORKSPACE.orgUserId,
          orgId: LOCAL_WORKSPACE.orgId,
          name: LOCAL_WORKSPACE.orgName,
          slug: LOCAL_WORKSPACE.orgSlug,
          role: 'owner',
          allowPublicSharing: false,
          features: LOCAL_FEATURE_FLAGS,
          memberCount: 1,
        },
      ]);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('profile: LEGACY {result} envelope built from LOCAL_WORKSPACE', () =>
    Effect.gen(function* () {
      const { api, scope } = yield* buildBackend;
      const res = expectOk(yield* api.request({ method: 'GET', path: '/apps/v1/me/profile' }), 200);
      assert.notProperty(res.bodyJson, 'success');
      const parsed = ViewerProfileResponseSchema.parse(res.bodyJson);
      assert.deepStrictEqual(parsed.result, {
        id: LOCAL_WORKSPACE.sub,
        email: LOCAL_WORKSPACE.email,
        name: LOCAL_WORKSPACE.name,
        image: null,
      });
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('cloud-only/deferred lanes answer GET-empty {success:true, results:[]}', () =>
    Effect.gen(function* () {
      const { api, scope } = yield* buildBackend;
      for (const route of [
        'calendars',
        'events',
        'recording-speakers',
        'note-generation-audits',
        'team-vocabulary',
      ]) {
        const res = expectOk(yield* api.request({ method: 'GET', path: `/apps/v1/me/${route}` }), 200);
        assert.deepStrictEqual(res.bodyJson, { success: true, results: [] }, route);
      }
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('anything else is a completed 404 exchange — never the INTERNAL arm', () =>
    Effect.gen(function* () {
      const { api, scope } = yield* buildBackend;
      const notFoundBody = { success: false, error: { code: 'NOT_FOUND' } };
      // Unknown route, the bare /apps/v1/me bootstrap, a write to a GET-empty
      // lane, and an unregistered method on a sync lane.
      for (const req of [
        { method: 'GET' as const, path: '/apps/v1/me/nothing-here' },
        { method: 'GET' as const, path: '/apps/v1/me' },
        { method: 'POST' as const, path: '/apps/v1/me/calendars', body: { id: 'cal_x' } },
        { method: 'PATCH' as const, path: '/apps/v1/me/tags' },
      ]) {
        const res = expectOk(yield* api.request(req), 404);
        assert.deepStrictEqual(res.bodyJson, notFoundBody, req.path);
      }
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('an unexpected store failure folds to the reserved INTERNAL envelope + log', () =>
    Effect.gen(function* () {
      const { api, product, logger, scope } = yield* buildBackend;
      // Close the raw client out from under the router: the next query throws.
      product.client.close();
      const res = yield* api.request({ method: 'GET', path: '/apps/v1/me/tags' });
      assert.deepStrictEqual(res, { error: { code: 'INTERNAL' } });
      assert.isDefined(logger.find(e => e.message === 'local backend request failed'));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a drizzle-path unique collision is classified as a unique violation', () =>
    Effect.gen(function* () {
      const { product, scope } = yield* buildBackend;
      // The sync driver surfaces the raw SqliteError (no DrizzleQueryError
      // wrapper), so the 409 mapping sees the SQLITE_CONSTRAINT_UNIQUE code.
      const insert = (id: string, word = 'Prismical') =>
        Effect.try({
          try: () => {
            const now = new Date().toISOString();
            product.db
              .insert(schema.vocabulary)
              .values({ id, word, isReplacement: false, createdAt: now, updatedAt: now })
              .run();
          },
          catch: error => error,
        });
      yield* insert('vcb_1');
      const error = failureOf(yield* Effect.exit(insert('vcb_2')));
      assert.isDefined(error, 'the duplicate word must fail');
      assert.isTrue(isUniqueViolation(error));
      assert.strictEqual(describeDbError(error), 'SqliteError/SQLITE_CONSTRAINT_UNIQUE');
      // A PRIMARY KEY collision reports a different extended code — the
      // "UNIQUE constraint failed" message branch is what classifies it.
      const pkError = failureOf(yield* Effect.exit(insert('vcb_1', 'Another')));
      assert.isDefined(pkError, 'the duplicate id must fail');
      assert.isTrue(isUniqueViolation(pkError));
      assert.strictEqual(describeDbError(pkError), 'SqliteError/SQLITE_CONSTRAINT_PRIMARYKEY');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a duplicate vocabulary word answers 409 CONFLICT through the route (cloud parity)', () =>
    Effect.gen(function* () {
      const { api, scope } = yield* buildBackend;
      expectOk(
        yield* api.request({
          method: 'POST',
          path: '/apps/v1/me/vocabulary',
          body: { id: 'voc_route_1', word: 'Prismical' },
        }),
        201
      );
      const dup = expectOk(
        yield* api.request({
          method: 'POST',
          path: '/apps/v1/me/vocabulary',
          body: { id: 'voc_route_2', word: 'Prismical' },
        }),
        409
      );
      assert.deepStrictEqual(dup.bodyJson, { success: false, error: { code: 'CONFLICT' } });
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('recording lane answers thin local acks because rows are the store’s job', () =>
    Effect.gen(function* () {
      const { api, scope } = yield* buildBackend;
      const recordingId = createId('recording');
      assert.deepStrictEqual(
        yield* api.createRecording({
          recordingId,
          title: 'Local take',
          captureMode: 'mic',
          startedAt: Date.now(),
        }),
        { ok: true, value: { recordingId } }
      );
      assert.deepStrictEqual(
        yield* api.uploadTranscriptionChunk(
          recordingId,
          { chunkIndex: 0, chunkStartMs: 0, source: 'mic' },
          new Uint8Array([1, 2, 3])
        ),
        { ok: true, value: [] }
      );
      assert.deepStrictEqual(
        yield* api.finalizeRecording(recordingId, {
          endedAt: Date.now(),
          durationMs: 1000,
          stagingExpected: false,
          transcriptionDeferred: false,
        }),
        { ok: true, value: { recordingId } }
      );
      assert.deepStrictEqual(yield* api.stageRecordingAudio(recordingId, []), {
        ok: true,
        value: { staged: false },
      });
      assert.deepStrictEqual(yield* api.abandonRecordingStaging(recordingId, 'no-audio'), {
        ok: true,
        value: undefined,
      });
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('the collab lane fails typed; Ask streams a provider error part when unconfigured', () =>
    Effect.gen(function* () {
      const { api, scope } = yield* buildBackend;
      // The fake AiProvider is unconfigured: the stream opens and carries the
      // not-configured message as an AI-SDK error part (the renderer shows it).
      const response = yield* api.openAskStream({ messages: [{ role: 'user', content: 'hi' }] });
      const text = yield* Effect.promise(() => response.text());
      assert.include(text, '"type":"error"');
      assert.include(text, 'Ask AI needs an AI provider');
      // WorkspaceTransport folds this to None → the renderer sees null.
      const collab = failureOf(yield* Effect.exit(api.collabToken));
      assert.instanceOf(collab, AuthStateError);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('GET /skills lists the three seeded system skills with the server `system` flag', () =>
    Effect.gen(function* () {
      const { api, scope } = yield* buildBackend;
      const res = expectOk(yield* api.request({ method: 'GET', path: '/apps/v1/me/skills' }), 200);
      const rows = (res.bodyJson as { results: Array<Record<string, unknown>> }).results;
      assert.deepStrictEqual(
        rows.map(row => row.id).sort(),
        [...SYSTEM_SKILLS.map(skill => skill.id)].sort()
      );
      for (const skill of SYSTEM_SKILLS) {
        const row = rows.find(r => r.id === skill.id)!;
        assert.strictEqual(row.system, true);
        assert.strictEqual(row.enabled, true);
        assert.strictEqual(row.body, skill.body);
        assert.deepStrictEqual(row.config, skill.config);
        assert.notProperty(row, 'isSystem');
      }
      // A second acquire re-seeds idempotently: still three rows, bodies intact.
      const again = expectOk(yield* api.request({ method: 'GET', path: '/apps/v1/me/skills' }), 200);
      assert.lengthOf((again.bodyJson as { results: unknown[] }).results, 3);
      // System rows cannot be deleted (403), user rows can be created over the dialect.
      const del = expectOk(
        yield* api.request({ method: 'DELETE', path: `/apps/v1/me/skills/${SYSTEM_SKILLS[0]!.id}` }),
        403
      );
      assert.deepStrictEqual(del.bodyJson, { success: false, error: { code: 'FORBIDDEN' } });
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('registers into WorkspaceTransport on acquire; scope close deregisters', () =>
    Effect.gen(function* () {
      const { api, transport, scope } = yield* buildBackend;
      const current = yield* transport.current;
      assert.isTrue(Option.isSome(current) && Option.getOrThrow(current) === api);
      const served = expectOk(
        yield* transport.request({ method: 'GET', path: '/apps/v1/me/folders' }),
        200
      );
      assert.deepStrictEqual(served.bodyJson, { success: true, results: [] });
      // Transport-level collabToken folds the typed failure to None.
      assert.isTrue(Option.isNone(yield* transport.collabToken));

      yield* Scope.close(scope, Exit.void);
      assert.isTrue(Option.isNone(yield* transport.current), 'cleared on scope close');
      assert.deepStrictEqual(yield* transport.request({ method: 'GET', path: '/apps/v1/me/folders' }), {
        error: { code: 'INTERNAL' },
      });
    })
  );

  it.effect('note create defaults the title; a manual rename bumps titleRevision', () =>
    Effect.gen(function* () {
      const { api, scope } = yield* buildBackend;
      const id = createId('note');
      const created = expectOk(
        yield* api.request({ method: 'POST', path: '/apps/v1/me/notes', body: { id } }),
        201
      );
      assert.strictEqual(created.bodyJson.result.title, 'Untitled note');
      assert.strictEqual(created.bodyJson.result.titleSource, 'placeholder');
      assert.strictEqual(created.bodyJson.result.titleRevision, 0);

      const renamed = expectOk(
        yield* api.request({
          method: 'PUT',
          path: `/apps/v1/me/notes/${id}`,
          body: { title: '  My meeting  ' },
        }),
        200
      );
      assert.strictEqual(renamed.bodyJson.result.title, 'My meeting');
      assert.strictEqual(renamed.bodyJson.result.titleSource, 'manual');
      assert.strictEqual(renamed.bodyJson.result.titleRevision, 1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('empty-string title resets to the default, following the body firstLine', () =>
    Effect.gen(function* () {
      const { api, product, scope } = yield* buildBackend;
      const id = createId('note');
      yield* api.request({ method: 'POST', path: '/apps/v1/me/notes', body: { id, title: 'Mine' } });
      // Plant a body read model behind the note, as the collaboration pipeline does.
      yield* Effect.promise(() =>
        product.db.update(schema.note).set({ firstLine: 'Standup notes' }).where(eq(schema.note.id, id))
      );
      const reset = expectOk(
        yield* api.request({ method: 'PUT', path: `/apps/v1/me/notes/${id}`, body: { title: '' } }),
        200
      );
      assert.strictEqual(reset.bodyJson.result.title, 'Standup notes');
      assert.strictEqual(reset.bodyJson.result.titleSource, 'first-line');
      // Create-with-title starts at revision 0 (no previous row to bump
      // against, for server parity); the explicit reset is intent #1.
      assert.strictEqual(reset.bodyJson.result.titleRevision, 1);

      // Without a first line the reset lands on the placeholder.
      yield* Effect.promise(() =>
        product.db.update(schema.note).set({ firstLine: null }).where(eq(schema.note.id, id))
      );
      const placeholder = expectOk(
        yield* api.request({ method: 'PUT', path: `/apps/v1/me/notes/${id}`, body: { title: '' } }),
        200
      );
      assert.strictEqual(placeholder.bodyJson.result.title, 'Untitled note');
      assert.strictEqual(placeholder.bodyJson.result.titleSource, 'placeholder');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a retried create with titleIntent default never demotes a manual title', () =>
    Effect.gen(function* () {
      const { api, scope } = yield* buildBackend;
      const id = createId('note');
      yield* api.request({ method: 'POST', path: '/apps/v1/me/notes', body: { id, title: 'Mine' } });
      const retried = expectOk(
        yield* api.request({
          method: 'POST',
          path: '/apps/v1/me/notes',
          body: { id, titleIntent: 'default' },
        }),
        200
      );
      assert.strictEqual(retried.bodyJson.result.title, 'Mine');
      assert.strictEqual(retried.bodyJson.result.titleSource, 'manual');
      // The retried placeholder is not a naming intent — revision unchanged.
      assert.strictEqual(retried.bodyJson.result.titleRevision, 0);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('notes: metadataUpdatedAt carries the client stamp; updatedAt never moves backwards', () =>
    Effect.gen(function* () {
      const { api, scope } = yield* buildBackend;
      const id = createId('note');
      const t1 = '2030-01-01T00:00:00.000Z';
      const t2 = '2030-01-02T00:00:00.000Z';

      // Create stores the client stamp verbatim on BOTH clocks (engine parity).
      const created = expectOk(
        yield* api.request({
          method: 'POST',
          path: '/apps/v1/me/notes',
          body: { id, title: 'Clock', updatedAt: t1 },
        }),
        201
      );
      assert.strictEqual(created.bodyJson.result.updatedAt, t1);
      assert.strictEqual(created.bodyJson.result.metadataUpdatedAt, t1);

      // A newer client stamp advances metadataUpdatedAt verbatim; the row
      // clock lands on max(now, incoming, current + 1ms) = the future stamp.
      const advanced = expectOk(
        yield* api.request({
          method: 'PUT',
          path: `/apps/v1/me/notes/${id}`,
          body: { starred: true, updatedAt: t2 },
        }),
        200
      );
      assert.strictEqual(advanced.bodyJson.result.metadataUpdatedAt, t2);
      assert.strictEqual(advanced.bodyJson.result.updatedAt, t2);

      // An EQUAL stamp still applies (LWW is strict-less-than) and the row
      // clock strictly advances (+1ms floor) so the delta cursor moves.
      const equalStamp = expectOk(
        yield* api.request({
          method: 'PUT',
          path: `/apps/v1/me/notes/${id}`,
          body: { starred: false, updatedAt: t2 },
        }),
        200
      );
      assert.strictEqual(equalStamp.bodyJson.applied, true);
      assert.isAbove(
        Date.parse(equalStamp.bodyJson.result.updatedAt),
        Date.parse(t2),
        'row clock strictly advances'
      );

      // A stale stamp is ignored: 200 {applied:false} with the winner echoed.
      const stale = expectOk(
        yield* api.request({
          method: 'PUT',
          path: `/apps/v1/me/notes/${id}`,
          body: { starred: true, updatedAt: t1 },
        }),
        200
      );
      assert.strictEqual(stale.bodyJson.applied, false);
      assert.strictEqual(stale.bodyJson.result.starred, false);
      yield* Scope.close(scope, Exit.void);
    })
  );
});
