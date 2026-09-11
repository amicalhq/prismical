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
import { Cause, Context, Effect, Exit, Fiber, Layer, Option, Scope, TestClock } from 'effect';
import type { TransportResponse } from '@prismical/desktop-contracts';
import { LOCAL_FEATURE_FLAGS, LOCAL_WORKSPACE } from '@prismical/desktop-contracts';
import {
  OrganizationsResponseSchema,
  ViewerProfileResponseSchema,
  UserPreferencesSchema,
} from '@prismical/api-contracts/apps/v1';
import { createId } from '@prismical/id';
import { fakeAiProviderLayer } from '../helpers/fake-workspace-env';
import { makeTestLogger, testConfigLayer, testI18nLayer } from '../helpers/test-layers';
import { NAME_NOTE_SKILL_ID, SYSTEM_SKILLS } from '@prismical/ai-prompts';
import { AuthStateError } from '../../src/main/domains/auth/service';
import { LocalBackendLive } from '../../src/main/domains/local-backend/live';
import { describeDbError, isUniqueViolation } from '../../src/main/domains/local-backend/wire';
import { WORKSPACE_READY_TIMEOUT, WorkspaceTransportLive } from '../../src/main/domains/transport/live';
import { WorkspaceBackend, WorkspaceTransport } from '../../src/main/domains/transport/service';
import { makeProductDbLayer } from '../../src/main/infra/product-db/live';
import * as schema from '../../src/main/infra/product-db/schema';
import { ProductDb } from '../../src/main/infra/product-db/service';

// A temp dir per test file keeps WAL siblings isolated (operational-db idiom).
const tempDir = mkdtempSync(path.join(tmpdir(), 'prismical-local-backend-test-'));
let dbSeq = 0;

/** Build the backend graph over a fresh file-backed product store. */
const buildBackendAt = (localDbPath?: string) => Effect.gen(function* () {
  dbSeq += 1;
  const logger = makeTestLogger();
  const env = Layer.mergeAll(
    testConfigLayer({ localDbPath: localDbPath ?? path.join(tempDir, `local-backend-${dbSeq}.db`) }),
    logger.layer,
    testI18nLayer(),
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
const buildBackend = buildBackendAt();

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

  it.effect('profile: direct resource built from LOCAL_WORKSPACE', () =>
    Effect.gen(function* () {
      const { api, scope } = yield* buildBackend;
      const res = expectOk(yield* api.request({ method: 'GET', path: '/apps/v1/me/profile' }), 200);
      assert.notProperty(res.bodyJson, 'success');
      const parsed = ViewerProfileResponseSchema.parse(res.bodyJson);
      assert.deepStrictEqual(parsed, {
        id: LOCAL_WORKSPACE.sub,
        email: LOCAL_WORKSPACE.email,
        name: LOCAL_WORKSPACE.name,
        image: null,
      });
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('cloud-only/deferred lanes answer GET-empty {results:[]}', () =>
    Effect.gen(function* () {
      const { api, scope } = yield* buildBackend;
      for (const route of [
        'calendars',
        'events',
        'recording-speakers',
        'note-generation-audits',
        'team-vocabulary',
      ]) {
        const res = expectOk(
          yield* api.request({ method: 'GET', path: `/apps/v1/me/${route}` }),
          200
        );
        assert.deepStrictEqual(res.bodyJson, { results: [] }, route);
      }
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('anything else is a completed 404 exchange — never the INTERNAL arm', () =>
    Effect.gen(function* () {
      const { api, scope } = yield* buildBackend;
      const notFoundBody = { error: { code: 'NOT_FOUND', message: 'Not found' } };
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

  it.effect(
    'a duplicate vocabulary word answers 409 CONFLICT through the route (cloud parity)',
    () =>
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
        assert.deepStrictEqual(dup.bodyJson, { error: { code: 'CONFLICT', message: 'Conflict' } });
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
        }),
        { ok: true, value: { recordingId } }
      );

      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect(
    'the collab lane fails typed; Ask streams a provider error part when unconfigured',
    () =>
      Effect.gen(function* () {
        const { api, scope } = yield* buildBackend;
        // The fake AiProvider is unconfigured: the stream opens and carries the
        // not-configured message as an AI-SDK error part (the renderer shows it).
        const response = yield* api.openAskStream({ messages: [{ role: 'user', content: 'hi' }] });
        const text = yield* Effect.promise(() => response.text());
        assert.include(text, '"type":"error"');
        assert.include(text, 'MODEL_NOT_CONFIGURED');
        // WorkspaceTransport folds this to None → the renderer sees null.
        const collab = failureOf(yield* Effect.exit(api.collabToken));
        assert.instanceOf(collab, AuthStateError);
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect('GET /skills lists available system skills and retains the gated seed in storage', () =>
    Effect.gen(function* () {
      const { api, product, scope } = yield* buildBackend;
      const available = SYSTEM_SKILLS.filter(skill => skill.id !== NAME_NOTE_SKILL_ID);
      const res = expectOk(yield* api.request({ method: 'GET', path: '/apps/v1/me/skills' }), 200);
      const rows = (res.bodyJson as { results: Array<Record<string, unknown>> }).results;
      assert.deepStrictEqual(
        rows.map(row => row.id).sort(),
        available.map(skill => skill.id).sort()
      );
      for (const skill of available) {
        const row = rows.find(r => r.id === skill.id)!;
        assert.strictEqual(row.system, true);
        assert.strictEqual(row.enabled, true);
        assert.strictEqual(row.body, skill.body);
        assert.deepStrictEqual(row.config, skill.config);
        assert.notProperty(row, 'isSystem');
      }
      // Delta and tombstone reads must keep the same rollout boundary.
      const again = expectOk(
        yield* api.request({
          method: 'GET',
          path: '/apps/v1/me/skills',
          query: { includeDeleted: 'true', since: '2000-01-01T00:00:00.000Z' },
        }),
        200
      );
      assert.deepStrictEqual(again.bodyJson.results, rows);
      const stored = yield* Effect.promise(() => product.db.select().from(schema.skill));
      assert.deepStrictEqual(
        stored.map(skill => skill.id).sort(),
        SYSTEM_SKILLS.map(skill => skill.id).sort()
      );
      assert.strictEqual(stored.find(skill => skill.id === NAME_NOTE_SKILL_ID)!.enabled, true);
      // System rows cannot be deleted (403), user rows can be created over the dialect.
      const del = expectOk(
        yield* api.request({
          method: 'DELETE',
          path: `/apps/v1/me/skills/${SYSTEM_SKILLS[0]!.id}`,
        }),
        403
      );
      assert.deepStrictEqual(del.bodyJson, { error: { code: 'FORBIDDEN', message: 'Forbidden' } });
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('refuses direct and stale writes of the gated Name note without echoing its row', () =>
    Effect.gen(function* () {
      const { api, product, scope } = yield* buildBackend;
      const path = `/apps/v1/me/skills/${NAME_NOTE_SKILL_ID}`;
      for (const updatedAt of ['2000-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z']) {
        for (const request of [
          { method: 'PUT' as const, path, body: { enabled: false, updatedAt } },
          {
            method: 'POST' as const,
            path: '/apps/v1/me/skills',
            body: {
              id: NAME_NOTE_SKILL_ID, name: 'Replacement', body: 'Rewrite this note.', updatedAt,
            },
          },
        ]) {
          const result = expectOk(yield* api.request(request), 404);
          assert.strictEqual(result.bodyJson.error.code, 'NOT_FOUND');
          assert.notProperty(result.bodyJson, 'result');
        }
      }
      expectOk(yield* api.request({ method: 'DELETE', path }), 404);
      expectOk(yield* api.request({ method: 'GET', path }), 404);
      const stored = yield* Effect.promise(() =>
        product.db.select().from(schema.skill).where(eq(schema.skill.id, NAME_NOTE_SKILL_ID))
      );
      assert.strictEqual(stored[0]!.enabled, true);
      assert.isNull(stored[0]!.deletedAt);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('registers into WorkspaceTransport on acquire; scope close deregisters', () =>
    Effect.gen(function* () {
      const { api, transport, scope } = yield* buildBackend;
      const current = yield* transport.current;
      assert.isTrue(Option.isSome(current) && Option.getOrThrow(current) === api);
      const served = expectOk(
        yield* transport.request({ method: 'GET', path: '/apps/v1/me/folders' }, { mode: 'local' }),
        200
      );
      assert.deepStrictEqual(served.bodyJson, { results: [] });
      // Transport-level collabToken folds the typed failure to None.
      assert.isTrue(Option.isNone(yield* transport.collabToken));

      yield* Scope.close(scope, Exit.void);
      assert.isTrue(Option.isNone(yield* transport.current), 'cleared on scope close');
      const pending = yield* transport
        .request({ method: 'GET', path: '/apps/v1/me/folders' }, { mode: 'local' })
        .pipe(Effect.fork);
      yield* TestClock.adjust(WORKSPACE_READY_TIMEOUT);
      assert.deepStrictEqual(
        yield* Fiber.join(pending),
        {
          error: { code: 'INTERNAL' },
        }
      );
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

  it.effect('freezes provisional titles once and ignores departures with a stale revision', () =>
    Effect.gen(function* () {
      const { api, product, scope } = yield* buildBackend;
      const id = createId('note');
      expectOk(yield* api.request({ method: 'POST', path: '/apps/v1/me/notes', body: { id } }), 201);
      const freeze = { id, title: 'First line', titleIntent: 'freeze', titleExpectedRevision: 0 };
      const frozen = expectOk(yield* api.request({ method: 'POST', path: '/apps/v1/me/notes', body: freeze }), 200).bodyJson.result;
      assert.strictEqual(frozen.title, 'First line');
      assert.strictEqual(frozen.titleSource, 'first-line-fixed');
      assert.strictEqual(frozen.titleRevision, 1);
      const retry = expectOk(yield* api.request({ method: 'POST', path: '/apps/v1/me/notes', body: freeze }), 200).bodyJson.result;
      assert.strictEqual(retry.titleRevision, 1);
      const renamed = expectOk(yield* api.request({ method: 'PUT', path: `/apps/v1/me/notes/${id}`, body: { title: 'Manual' } }), 200).bodyJson.result;
      const stale = expectOk(yield* api.request({ method: 'POST', path: '/apps/v1/me/notes', body: freeze }), 200).bodyJson.result;
      assert.strictEqual(stale.title, 'Manual');
      assert.strictEqual(stale.titleRevision, renamed.titleRevision);
      product.db.update(schema.note).set({ title: 'Stored first line', titleSource: 'first-line', titleRevision: 7 }).where(eq(schema.note.id, id)).run();
      const staleDefault = expectOk(yield* api.request({ method: 'POST', path: '/apps/v1/me/notes', body: freeze }), 200).bodyJson.result;
      assert.strictEqual(staleDefault.title, 'Stored first line');
      assert.strictEqual(staleDefault.titleSource, 'first-line');
      assert.strictEqual(staleDefault.titleRevision, 7);
      const blank = expectOk(yield* api.request({ method: 'POST', path: '/apps/v1/me/notes', body: { id, title: ' ', titleIntent: 'freeze', titleExpectedRevision: 7 } }), 200).bodyJson.result;
      assert.strictEqual(blank.titleSource, 'first-line');
      const partial = expectOk(yield* api.request({ method: 'POST', path: '/apps/v1/me/notes', body: { id, titleIntent: 'freeze', titleExpectedRevision: 7 } }), 200).bodyJson.result;
      assert.strictEqual(partial.title, 'Stored first line');
      assert.strictEqual(partial.titleSource, 'first-line-fixed');
      assert.strictEqual(partial.titleRevision, 8);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('empty-string title resets to the default, following the body firstLine', () =>
    Effect.gen(function* () {
      const { api, product, scope } = yield* buildBackend;
      const id = createId('note');
      yield* api.request({
        method: 'POST',
        path: '/apps/v1/me/notes',
        body: { id, title: 'Mine' },
      });
      // Plant a body read model behind the note, as the collaboration pipeline does.
      yield* Effect.promise(() =>
        product.db
          .update(schema.note)
          .set({ firstLine: 'Standup notes' })
          .where(eq(schema.note.id, id))
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
      yield* api.request({
        method: 'POST',
        path: '/apps/v1/me/notes',
        body: { id, title: 'Mine' },
      });
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

  it.effect(
    'notes: metadataUpdatedAt carries the client stamp; updatedAt never moves backwards',
    () =>
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

describe('local account preferences', () => {
  const preferencesPath = '/apps/v1/me/preferences';

  it.effect('seeds the language group once and preserves unrelated stored preferences', () =>
    Effect.gen(function* () {
      const { api, product, scope } = yield* buildBackend;
      assert.deepStrictEqual(expectOk(yield* api.request({ method: 'GET', path: preferencesPath }), 200).bodyJson, { language: null });
      yield* Effect.promise(() => product.db.insert(schema.userPreference).values({
        id: 1, prefs: { appearance: { density: 'compact' }, legacy: true, language: null },
      }));
      const seeded = expectOk(yield* api.request({
        method: 'POST', path: preferencesPath, body: { language: { interfaceLanguage: 'ja' } },
      }), 200).bodyJson;
      assert.deepStrictEqual(UserPreferencesSchema.parse(seeded), {
        language: { interfaceLanguage: 'ja', aiOutputLanguage: 'source' },
      });
      const repeated = expectOk(yield* api.request({
        method: 'POST', path: preferencesPath, body: { language: { interfaceLanguage: 'de' } },
      }), 200).bodyJson;
      assert.deepStrictEqual(repeated, seeded);
      const patched = expectOk(yield* api.request({
        method: 'PATCH', path: preferencesPath, body: { language: { aiOutputLanguage: 'es' } },
      }), 200).bodyJson;
      assert.deepStrictEqual(patched, { language: { interfaceLanguage: 'ja', aiOutputLanguage: 'es' } });
      assert.deepStrictEqual(product.db.select().from(schema.userPreference).get()!.prefs, {
        appearance: { density: 'compact' }, legacy: true,
        language: { interfaceLanguage: 'ja', aiOutputLanguage: 'es' },
      });
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('partial updates initialize defaults and survive reopening the local database', () =>
    Effect.gen(function* () {
      const dbPath = path.join(tempDir, `preferences-${++dbSeq}.db`);
      const first = yield* buildBackendAt(dbPath);
      const saved = expectOk(yield* first.api.request({
        method: 'PATCH', path: preferencesPath, body: { language: { aiOutputLanguage: 'hi' } },
      }), 200).bodyJson;
      assert.deepStrictEqual(saved, { language: { interfaceLanguage: 'en', aiOutputLanguage: 'hi' } });
      yield* Scope.close(first.scope, Exit.void);
      const second = yield* buildBackendAt(dbPath);
      assert.deepStrictEqual(expectOk(yield* second.api.request({ method: 'GET', path: preferencesPath }), 200).bodyJson, saved);
      expectOk(yield* second.api.request({
        method: 'PATCH', path: preferencesPath, body: { language: { interfaceLanguage: 'de' } },
      }), 200);
      assert.deepStrictEqual(expectOk(yield* second.api.request({ method: 'GET', path: preferencesPath }), 200).bodyJson, {
        language: { interfaceLanguage: 'de', aiOutputLanguage: 'hi' },
      });
      const separate = yield* buildBackend;
      assert.deepStrictEqual(expectOk(yield* separate.api.request({ method: 'GET', path: preferencesPath }), 200).bodyJson, { language: null });
      yield* Scope.close(second.scope, Exit.void);
      yield* Scope.close(separate.scope, Exit.void);
    })
  );

  it.effect('concurrent seeds keep the first choice and field updates do not overwrite each other', () =>
    Effect.gen(function* () {
      const dbPath = path.join(tempDir, `preferences-${++dbSeq}.db`);
      const first = yield* buildBackendAt(dbPath);
      const second = yield* buildBackendAt(dbPath);
      const seeds = yield* Effect.all([
        first.api.request({ method: 'POST', path: preferencesPath, body: { language: { interfaceLanguage: 'ja' } } }),
        second.api.request({ method: 'POST', path: preferencesPath, body: { language: { interfaceLanguage: 'de' } } }),
      ], { concurrency: 'unbounded' });
      const choice = expectOk(seeds[0]!, 200).bodyJson;
      assert.include(['ja', 'de'], choice.language.interfaceLanguage);
      assert.deepStrictEqual(expectOk(seeds[1]!, 200).bodyJson, choice);
      const patches = yield* Effect.all([
        first.api.request({ method: 'PATCH', path: preferencesPath, body: { language: { interfaceLanguage: 'zh-TW' } } }),
        second.api.request({ method: 'PATCH', path: preferencesPath, body: { language: { aiOutputLanguage: 'fr' } } }),
      ], { concurrency: 'unbounded' });
      for (const result of patches) expectOk(result, 200);
      assert.deepStrictEqual(expectOk(yield* first.api.request({ method: 'GET', path: preferencesPath }), 200).bodyJson, {
        language: { interfaceLanguage: 'zh-TW', aiOutputLanguage: 'fr' },
      });
      yield* Scope.close(first.scope, Exit.void);
      yield* Scope.close(second.scope, Exit.void);
    })
  );

  it.effect('rejects invalid groups, fields and languages without writing preferences', () =>
    Effect.gen(function* () {
      const { api, product, scope } = yield* buildBackend;
      for (const method of ['POST', 'PATCH'] as const) {
        for (const body of [
          {}, null, { language: {} }, { appearance: {} },
          { language: { interfaceLanguage: 'fr' } },
          { language: { interfaceLanguage: 'en', unexpected: true } },
          { language: { interfaceLanguage: 'en' }, userId: 'another-user' },
          { language: { aiOutputLanguage: 'auto' } },
        ]) expectOk(yield* api.request({ method, path: preferencesPath, body }), 400);
      }
      expectOk(yield* api.request({ method: 'POST', path: preferencesPath, body: {
        language: { interfaceLanguage: 'en', aiOutputLanguage: 'es' },
      } }), 400);
      for (const method of ['PUT', 'DELETE'] as const)
        expectOk(yield* api.request({ method, path: preferencesPath, body: { language: { interfaceLanguage: 'en' } } }), 404);
      expectOk(yield* api.request({ method: 'GET', path: `${preferencesPath}/language` }), 404);
      assert.isEmpty(product.db.select().from(schema.userPreference).all());
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a failed save retains the last saved preference', () =>
    Effect.gen(function* () {
      const { api, product, scope } = yield* buildBackend;
      const saved = expectOk(yield* api.request({
        method: 'POST', path: preferencesPath, body: { language: { interfaceLanguage: 'es' } },
      }), 200).bodyJson;
      product.client.exec("CREATE TRIGGER fail_preferences BEFORE UPDATE ON user_preference BEGIN SELECT RAISE(ABORT, 'test failure'); END");
      assert.deepStrictEqual(yield* api.request({
        method: 'PATCH', path: preferencesPath, body: { language: { aiOutputLanguage: 'ja' } },
      }), { error: { code: 'INTERNAL' } });
      assert.deepStrictEqual(expectOk(yield* api.request({ method: 'GET', path: preferencesPath }), 200).bodyJson, saved);
      assert.isFalse(product.client.inTransaction);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('rejects explicit undefined IPC fields without erasing saved preferences', () =>
    Effect.gen(function* () {
      const { api, product, scope } = yield* buildBackend;
      expectOk(yield* api.request({
        method: 'POST', path: preferencesPath, body: { language: undefined },
      }), 400);
      assert.isEmpty(product.db.select().from(schema.userPreference).all());
      const saved = expectOk(yield* api.request({
        method: 'PATCH', path: preferencesPath,
        body: { language: { interfaceLanguage: 'ja', aiOutputLanguage: 'es' } },
      }), 200).bodyJson;
      for (const body of [
        { language: undefined },
        { language: { interfaceLanguage: undefined } },
        { language: { aiOutputLanguage: undefined } },
        { language: { interfaceLanguage: 'de', aiOutputLanguage: undefined } },
        { language: { interfaceLanguage: undefined, aiOutputLanguage: 'fr' } },
      ]) {
        expectOk(yield* api.request({ method: 'PATCH', path: preferencesPath, body }), 400);
        assert.deepStrictEqual(expectOk(yield* api.request({ method: 'GET', path: preferencesPath }), 200).bodyJson, saved);
      }
      yield* Scope.close(scope, Exit.void);
    })
  );
});
