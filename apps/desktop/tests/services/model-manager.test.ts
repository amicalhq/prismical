/**
 * ModelManager — the hardened downloader and disk-to-database reconcile
 * against a local node:http fixture that behaves like Hugging Face's
 * `resolve/main` (302 → origin, Range/206 capable, ETag) and can cut or stall
 * the transfer mid-body. Electron-free: real fs in a temp dir, the fake
 * OperationalDb (local-model rows opted in), a fake free-space probe.
 *
 * The downloader and reconciliation hardening behaviors are pinned here:
 *   .part + fsync + atomic rename ....... happy path (no .part survives, final sha1)
 *   streaming SHA-1 / mismatch .......... checksum test (typed error, .part discarded)
 *   Range resume re-following the 302 ... resume test (Range on the /redirect origin, 206)
 *   size/etag change ⇒ restart from 0 ... changed-resource test (3 requests, v2 sha1)
 *   Range ignored (200) ⇒ restart ....... ignore-range test
 *   statfs + 10% headroom ............... insufficient-space test (typed + published, 0 requests)
 *   backpressure ........................ 8 MB through a 16 KB WriteStream hwm (happy path)
 *   cancel / scope close ⇒ no .part ..... cancel + scope tests
 *   cancel outside the stream ........... header-await cancel (entry cleared, .part removed)
 *   transient ranged non-2xx keeps .part  429-resume test; 416 = definitive restart from 0
 *   pre-flight failure published ........ models-dir-is-a-file test (error entry + typed io)
 *   throttled progress .................. ≤ ~100 downloading publishes for 8 MB
 *   reconcile matrix .................... rows/files/.part/missing-dir tests
 *   reconcile vs download race .......... gated-upsert race (removed delta spares the fresh row)
 *   VAD auto-download ................... a whisper install kicks the vad entry; its failure is isolated
 *   kept .part / blind resume ........... reconcile keeps catalogue-named .part; SHA-1 is the backstop
 */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import * as fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Context, Deferred, Effect, Exit, Layer, Option, Scope, Stream } from 'effect';
import type { ModelsStateView } from '@prismical/desktop-contracts';
import { makeFakeOperationalDb } from '../helpers/fake-operational-db';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import { OperationalDb, type LocalModelRow } from '../../src/main/infra/operational-db/service';
import {
  MODEL_CATALOGUE,
  RECOMMENDED_MODEL_ID,
  VAD_MODEL_ID,
} from '../../src/main/domains/models/catalogue';
import type { ModelCatalogueEntry } from '../../src/main/domains/models/catalogue';
import { makeModelManagerLive } from '../../src/main/domains/models/live';
import { ModelManager, type ModelManagerApi } from '../../src/main/domains/models/service';
import { PendingReset } from '../../src/main/infra/pending-reset/service';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'prismical-models-test-'));
let dirCounter = 0;
/** A fresh, NOT yet created models dir per test (proves the lazy mkdir). */
const freshDir = () => path.join(tempRoot, `models-${dirCounter++}`);

const MB = 1024 * 1024;

/** Deterministic pseudo-random bytes (compressible-hostile, so every chunk differs). */
const makeBody = (length: number, seed: number): Buffer => {
  const body = Buffer.alloc(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    body[i] = x >>> 24;
  }
  return body;
};
const sha1 = (bytes: Buffer): string => createHash('sha1').update(bytes).digest('hex');

interface FixtureBehaviour {
  body: Buffer;
  etag: string;
  /** Answer Range with 206 (HF/CDN behaviour). false ⇒ 200 with the full body. */
  supportsRange: boolean;
  /** Answer a RANGED request with this bare status (a transient throttle/refusal). */
  rangedStatus: number | null;
  /** Accept the request but never send response headers (holds the header await). */
  stallHeaders: boolean;
  /** Send this many bytes, then cut the socket (transport failure mid-body). */
  failAfter: number | null;
  /** Send this many bytes, then keep the response open forever. */
  stallAfter: number | null;
}

/** A tiny HF-shaped origin: /redirect → 302 → /model.bin (Range/ETag capable). */
const makeFixture = () =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{
          url: string;
          requests: Array<{ path: string; range: string | null }>;
          behaviour: FixtureBehaviour;
          server: Server;
        }>(resolve => {
          const requests: Array<{ path: string; range: string | null }> = [];
          const behaviour: FixtureBehaviour = {
            body: Buffer.alloc(0),
            etag: '"v1"',
            supportsRange: true,
            rangedStatus: null,
            stallHeaders: false,
            failAfter: null,
            stallAfter: null,
          };
          const server = createServer((req, res) => {
            requests.push({ path: req.url ?? '', range: req.headers.range ?? null });
            // Accept the connection but never answer: the client fiber parks
            // awaiting response headers (the pre-transfer phase).
            if (behaviour.stallHeaders) return;
            if (req.url === '/redirect') {
              res.writeHead(302, { Location: '/model.bin' });
              res.end();
              return;
            }
            const total = behaviour.body.length;
            let start = 0;
            const range = req.headers.range;
            if (typeof range === 'string' && behaviour.rangedStatus !== null) {
              res.writeHead(behaviour.rangedStatus);
              res.end();
              return;
            }
            if (typeof range === 'string' && behaviour.supportsRange) {
              start = Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0);
              if (start >= total) {
                res.writeHead(416, { 'Content-Range': `bytes */${total}` });
                res.end();
                return;
              }
              res.writeHead(206, {
                'Content-Range': `bytes ${start}-${total - 1}/${total}`,
                'Content-Length': total - start,
                ETag: behaviour.etag,
              });
            } else {
              res.writeHead(200, { 'Content-Length': total, ETag: behaviour.etag });
            }
            const slice = behaviour.body.subarray(start);
            const cut = behaviour.failAfter ?? behaviour.stallAfter;
            if (cut !== null && cut < slice.length) {
              // Flush exactly `cut` bytes, then either sever the socket or stall.
              res.write(slice.subarray(0, cut), () => {
                if (behaviour.failAfter !== null) res.destroy();
              });
              return;
            }
            res.end(slice);
          });
          server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address !== null ? address.port : 0;
            resolve({ url: `http://127.0.0.1:${port}`, requests, behaviour, server });
          });
        })
    ),
    fixture =>
      Effect.promise(
        () =>
          new Promise<void>(resolve => {
            fixture.server.closeAllConnections();
            fixture.server.close(() => resolve());
          })
      )
  );

const entryFor = (
  url: string,
  body: Buffer,
  overrides: Partial<ModelCatalogueEntry> = {}
): ModelCatalogueEntry => ({
  id: 'test-model',
  name: 'Test Model',
  filename: 'test-model.bin',
  downloadUrl: `${url}/model.bin`,
  sha1: sha1(body),
  sizeBytes: body.length,
  kind: 'whisper',
  recommended: true,
  ...overrides,
});

const build = (options: {
  readonly catalogue: ReadonlyArray<ModelCatalogueEntry>;
  readonly modelsDir: string;
  readonly rows?: ReadonlyArray<LocalModelRow>;
  readonly freeBytes?: () => number;
}) => {
  const logger = makeTestLogger();
  const db = makeFakeOperationalDb({}, { localModels: options.rows ?? [] });
  const layer = makeModelManagerLive({
    catalogue: options.catalogue,
    probe: { freeBytes: async () => options.freeBytes?.() ?? Number.MAX_SAFE_INTEGER },
  }).pipe(
    Layer.provide(testConfigLayer({ modelsDir: options.modelsDir })),
    Layer.provide(db.layer),
    Layer.provide(Layer.succeed(PendingReset, { applied: null })),
    Layer.provide(logger.layer)
  );
  return { logger, db, layer };
};

const modelOf = (state: ModelsStateView, id: string) => {
  const model = state.models.find(m => m.id === id);
  assert.isDefined(model, `model ${id} in state`);
  return model as NonNullable<typeof model>;
};

/** Resolve with the first snapshot satisfying `predicate` (the current one replays first). */
const waitFor = (manager: ModelManagerApi, predicate: (state: ModelsStateView) => boolean) =>
  manager.state.changes.pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow)
  );

/**
 * Real-time poll (like boot-layer.test's awaitCheckCount): the conditions here
 * settle through fs/http promises on the event loop, which `Effect.yieldNow`
 * alone never drives. TestClock is untouched (the downloader has no timers).
 */
const awaitUntil = (predicate: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if (predicate()) return;
      yield* Effect.promise(() => new Promise(resolve => setTimeout(resolve, 2)));
    }
    assert.fail(`timed out waiting for ${what}`);
  });

const RECONCILED = 'local models reconciled';
/** The boot reconcile is forked at acquire; wait for it before staging `.part` fixtures. */
const awaitBootReconcile = (logger: ReturnType<typeof makeTestLogger>) =>
  awaitUntil(() => logger.find(e => e.message === RECONCILED) !== undefined, 'boot reconcile');

const exists = (file: string) => fs.existsSync(file);
const fileSha1 = (file: string) => sha1(fs.readFileSync(file));

describe('ModelManager catalogue', () => {
  it('ships six multilingual ggml entries, the recommended English base, and the Silero VAD entry', () => {
    const hf = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
    const byId = Object.fromEntries(MODEL_CATALOGUE.map(entry => [entry.id, entry]));
    const pins: Array<[string, string, string]> = [
      ['whisper-tiny', 'ggml-tiny.bin', 'bd577a113a864445d4c299885e0cb97d4ba92b5f'],
      ['whisper-base', 'ggml-base.bin', '465707469ff3a37a2b9b8d8f89f2f99de7299dac'],
      ['whisper-small', 'ggml-small.bin', '55356645c2b361a969dfd0ef2c5a50d530afd8d5'],
      ['whisper-medium', 'ggml-medium.bin', 'fd9727b6e1217c2f614f9b698455c4ffd82463b4'],
      ['whisper-large-v3', 'ggml-large-v3.bin', 'ad82bf6a9043ceed055076d0fd39f5f186ff8062'],
      [
        'whisper-large-v3-turbo',
        'ggml-large-v3-turbo.bin',
        '4af2b29d7ec73d781377bfd1758ca957a807e941',
      ],
      ['whisper-base-en', 'ggml-base.en.bin', '137c40403d78fd54d454da0f9bd998f78703390c'],
    ];
    assert.strictEqual(MODEL_CATALOGUE.length, pins.length + 1);
    for (const [id, filename, hash] of pins) {
      const entry = byId[id];
      assert.isDefined(entry, id);
      assert.strictEqual(entry?.filename, filename);
      assert.strictEqual(entry?.sha1, hash);
      assert.strictEqual(entry?.downloadUrl, `${hf}/${filename}`);
      assert.strictEqual(entry?.kind, 'whisper');
      assert.isTrue(Number.isInteger(entry?.sizeBytes) && (entry?.sizeBytes ?? 0) > 0);
    }
    // The one VAD entry — whisper.cpp's ggml Silero conversion from the
    // ggml-org/whisper-vad repo (NOT ggerganov/whisper.cpp), exact size,
    // never recommended.
    const vad = byId[VAD_MODEL_ID];
    assert.isDefined(vad, VAD_MODEL_ID);
    assert.strictEqual(VAD_MODEL_ID, 'silero-vad-v5');
    assert.strictEqual(vad?.filename, 'ggml-silero-v5.1.2.bin');
    assert.strictEqual(vad?.sha1, 'a372f48dcf0bd9e4330eef2802bc46e061c19634');
    assert.strictEqual(
      vad?.downloadUrl,
      'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin'
    );
    assert.strictEqual(vad?.sizeBytes, 885_098);
    assert.strictEqual(vad?.kind, 'vad');
    assert.notStrictEqual(vad?.recommended, true);
    // Exactly one recommended default: the English base with its exact size.
    assert.deepStrictEqual(
      MODEL_CATALOGUE.filter(entry => entry.recommended).map(entry => entry.id),
      [RECOMMENDED_MODEL_ID]
    );
    assert.strictEqual(byId[RECOMMENDED_MODEL_ID]?.sizeBytes, 147_964_211);
    assert.strictEqual(new Set(MODEL_CATALOGUE.map(entry => entry.filename)).size, pins.length + 1);
  });
});

describe('ModelManager download', () => {
  it.effect(
    'downloads via the 302: .part → fsync → atomic rename, SHA-1 verified, row upserted, throttled progress',
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const fixture = yield* makeFixture().pipe(Scope.extend(scope));
        const body = makeBody(8 * MB, 1);
        fixture.behaviour.body = body;
        const entry = entryFor(fixture.url, body, { downloadUrl: `${fixture.url}/redirect` });
        const modelsDir = freshDir();
        const { layer, db } = build({ catalogue: [entry], modelsDir });
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        const manager = Context.get(ctx, ModelManager);
        assert.isFalse(exists(modelsDir), 'no mkdir at build');

        const seen: ModelsStateView[] = [];
        yield* Stream.runForEach(manager.state.changes, s => Effect.sync(() => seen.push(s))).pipe(
          Effect.forkIn(scope)
        );

        assert.isTrue(Option.isNone(yield* manager.installedPath('test-model')));
        yield* manager.download('test-model');
        const done = yield* waitFor(manager, s => modelOf(s, 'test-model').installed);

        const final = path.join(modelsDir, 'test-model.bin');
        assert.strictEqual(fileSha1(final), entry.sha1);
        assert.isFalse(exists(`${final}.part`), 'no .part survives a verified download');
        const row = db.localModels.get('test-model');
        assert.strictEqual(row?.path, final);
        assert.strictEqual(row?.sizeBytes, body.length);
        assert.strictEqual(row?.checksum, entry.sha1);
        assert.isString(row?.verifiedAt);
        const view = modelOf(done, 'test-model');
        assert.isTrue(view.installed);
        assert.strictEqual(view.installedAt, row?.downloadedAt);
        assert.isNull(view.download);
        assert.deepStrictEqual(yield* manager.installedPath('test-model'), Option.some(final));

        // The redirect was followed to the origin, which saw ONE plain request.
        assert.deepStrictEqual(
          fixture.requests.map(r => r.path),
          ['/redirect', '/model.bin']
        );
        assert.isNull(fixture.requests[1]?.range);

        // Progress: downloading → verifying → installed, bytes monotonic, and
        // throttled (1% steps of 8 MB ⇒ ≤ ~100 publishes, not one per 16 KB chunk).
        const downloads = seen
          .map(s => modelOf(s, 'test-model').download)
          .filter(d => d !== null);
        const statuses = [...new Set(downloads.map(d => d.status))];
        assert.deepStrictEqual(statuses, ['downloading', 'verifying']);
        const bytes = downloads.map(d => d.bytesDownloaded);
        for (let i = 1; i < bytes.length; i++) assert.isAtLeast(bytes[i], bytes[i - 1]);
        assert.strictEqual(downloads.at(-1)?.bytesDownloaded, body.length);
        assert.strictEqual(downloads.at(-1)?.totalBytes, body.length);
        const publishes = downloads.filter(d => d.status === 'downloading').length;
        assert.isAtLeast(publishes, 10, 'progress actually flowed');
        assert.isAtMost(publishes, 105, 'progress throttled to ~1% steps');

        // Installed ⇒ a second download is a typed refusal.
        const again = yield* Effect.exit(manager.download('test-model'));
        assert.isTrue(Exit.isFailure(again));
        if (Exit.isFailure(again)) assert.include(JSON.stringify(again.cause), 'already-installed');
        const unknown = yield* Effect.exit(manager.download('nope'));
        if (Exit.isFailure(unknown)) assert.include(JSON.stringify(unknown.cause), 'unknown-model');
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect('a SHA-1 mismatch discards the .part and surfaces a typed error state — never an install', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const body = makeBody(2 * MB, 2);
      fixture.behaviour.body = body;
      const entry = entryFor(fixture.url, body, { sha1: 'da39a3ee5e6b4b0d3255bfef95601890afd80709' });
      const modelsDir = freshDir();
      const { layer, db, logger } = build({ catalogue: [entry], modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);

      yield* manager.download('test-model');
      const errored = yield* waitFor(
        manager,
        s => modelOf(s, 'test-model').download?.status === 'error'
      );
      assert.strictEqual(modelOf(errored, 'test-model').download?.error, 'checksum-mismatch');
      assert.isFalse(modelOf(errored, 'test-model').installed);
      assert.isFalse(exists(path.join(modelsDir, 'test-model.bin')));
      assert.isFalse(exists(path.join(modelsDir, 'test-model.bin.part')), 'mismatched bytes discarded');
      assert.isUndefined(db.localModels.get('test-model'));
      assert.isDefined(
        logger.find(e => e.level === 'warn' && e.message === 'model download failed')
      );
      // cancel on an error entry dismisses it.
      yield* manager.cancel('test-model');
      assert.isNull(modelOf(yield* manager.list, 'test-model').download);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('cancel mid-stream interrupts the fiber, removes the .part, leaves no row; a retry starts clean', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const body = makeBody(4 * MB, 3);
      fixture.behaviour.body = body;
      fixture.behaviour.stallAfter = 1 * MB;
      const entry = entryFor(fixture.url, body);
      const modelsDir = freshDir();
      const { layer, db, logger } = build({ catalogue: [entry], modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);
      const part = path.join(modelsDir, 'test-model.bin.part');

      yield* manager.download('test-model');
      yield* waitFor(manager, s => (modelOf(s, 'test-model').download?.bytesDownloaded ?? 0) > 0);
      yield* awaitUntil(() => exists(part), '.part');
      assert.isTrue(exists(part), 'the transfer is mid-stream in the .part');
      // In flight ⇒ a second download is a typed refusal.
      const busy = yield* Effect.exit(manager.download('test-model'));
      if (Exit.isFailure(busy)) assert.include(JSON.stringify(busy.cause), 'download-in-progress');

      yield* manager.cancel('test-model');
      assert.isFalse(exists(part), 'cancel removed the .part');
      assert.isFalse(exists(path.join(modelsDir, 'test-model.bin')));
      assert.isUndefined(db.localModels.get('test-model'));
      const after = yield* manager.list;
      assert.isNull(modelOf(after, 'test-model').download);
      assert.isFalse(modelOf(after, 'test-model').installed);
      assert.isDefined(logger.find(e => e.message === 'model download cancelled'));

      // Retry from a clean slate: no Range (the .part is gone), full body, installed.
      fixture.behaviour.stallAfter = null;
      yield* manager.download('test-model');
      yield* waitFor(manager, s => modelOf(s, 'test-model').installed);
      assert.isNull(fixture.requests.at(-1)?.range);
      assert.strictEqual(fileSha1(path.join(modelsDir, 'test-model.bin')), entry.sha1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('scope close interrupts an in-flight download and removes its .part', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const body = makeBody(4 * MB, 4);
      fixture.behaviour.body = body;
      fixture.behaviour.stallAfter = 1 * MB;
      const entry = entryFor(fixture.url, body);
      const modelsDir = freshDir();
      const { layer } = build({ catalogue: [entry], modelsDir });
      const managerScope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(managerScope));
      const manager = Context.get(ctx, ModelManager);
      const part = path.join(modelsDir, 'test-model.bin.part');

      yield* manager.download('test-model');
      yield* waitFor(manager, s => (modelOf(s, 'test-model').download?.bytesDownloaded ?? 0) > 0);
      yield* awaitUntil(() => exists(part), '.part');
      assert.isTrue(exists(part));

      yield* Scope.close(managerScope, Exit.void);
      assert.isFalse(exists(part), 'boot-scope close left no .part behind');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('resumes a cross-boot .part with a Range request through the 302 (206) and hashes the prefix', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const body = makeBody(3 * MB, 5);
      fixture.behaviour.body = body;
      const entry = entryFor(fixture.url, body, { downloadUrl: `${fixture.url}/redirect` });
      const modelsDir = freshDir();
      // A `.part` left by an EARLIER BOOT, staged before the manager exists:
      // reconcile keeps a catalogue-named `.part` and the next download
      // resumes it blind — this instance has no resume memory for it.
      fs.mkdirSync(modelsDir, { recursive: true });
      const prefix = 1 * MB + 123;
      fs.writeFileSync(path.join(modelsDir, 'test-model.bin.part'), body.subarray(0, prefix));
      const { layer, logger } = build({ catalogue: [entry], modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);
      yield* awaitBootReconcile(logger);
      assert.isTrue(
        exists(path.join(modelsDir, 'test-model.bin.part')),
        'reconcile kept the resumable .part'
      );
      assert.deepStrictEqual(logger.find(e => e.message === RECONCILED)?.data, {
        removed: 0,
        adopted: 0,
        partsDeleted: 0,
      });

      yield* manager.download('test-model');
      yield* waitFor(manager, s => modelOf(s, 'test-model').installed);
      // The Range header survived the redirect and the origin answered 206.
      assert.deepStrictEqual(fixture.requests, [
        { path: '/redirect', range: `bytes=${prefix}-` },
        { path: '/model.bin', range: `bytes=${prefix}-` },
      ]);
      // The whole file (resumed prefix + tail) verifies against the pin.
      assert.strictEqual(fileSha1(path.join(modelsDir, 'test-model.bin')), entry.sha1);
      assert.isFalse(exists(path.join(modelsDir, 'test-model.bin.part')));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a transport failure keeps the .part; the retry resumes, and a changed resource restarts from 0', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const v1 = makeBody(3 * MB, 6);
      const v2 = makeBody(3 * MB + 777, 7);
      fixture.behaviour.body = v1;
      fixture.behaviour.etag = '"v1"';
      fixture.behaviour.failAfter = 1 * MB;
      // The pin is v2's hash: the v1 attempt dies at the transport, never at verify.
      const entry = entryFor(fixture.url, v2);
      const modelsDir = freshDir();
      const { layer, logger } = build({ catalogue: [entry], modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);
      const part = path.join(modelsDir, 'test-model.bin.part');

      yield* manager.download('test-model');
      const errored = yield* waitFor(
        manager,
        s => modelOf(s, 'test-model').download?.status === 'error'
      );
      assert.strictEqual(modelOf(errored, 'test-model').download?.error, 'network');
      assert.isTrue(exists(part), 'a transport failure keeps the .part for resume');
      // The kept prefix is whatever arrived before the cut (the fixture's RST
      // can drop a few kernel-buffered bytes) — the resume offset must match it.
      const kept = fs.statSync(part).size;
      assert.isAbove(kept, 0);
      assert.isAtMost(kept, 1 * MB);

      // Upstream changed (new size + etag). The retry sends Range, sees the
      // disagreement in the 206, and restarts from 0 with a fresh request.
      fixture.behaviour.body = v2;
      fixture.behaviour.etag = '"v2"';
      fixture.behaviour.failAfter = null;
      yield* manager.download('test-model');
      yield* waitFor(manager, s => modelOf(s, 'test-model').installed);
      assert.deepStrictEqual(
        fixture.requests.map(r => r.range),
        [null, `bytes=${kept}-`, null]
      );
      assert.isDefined(logger.find(e => e.message === 'model download restarting from 0'));
      assert.strictEqual(fileSha1(path.join(modelsDir, 'test-model.bin')), sha1(v2));
      assert.isFalse(exists(part));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a server that ignores Range (200) restarts from 0 with that body', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const body = makeBody(2 * MB, 8);
      fixture.behaviour.body = body;
      fixture.behaviour.supportsRange = false;
      const entry = entryFor(fixture.url, body);
      const modelsDir = freshDir();
      const { layer, logger } = build({ catalogue: [entry], modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);
      yield* awaitBootReconcile(logger);
      fs.mkdirSync(modelsDir, { recursive: true });
      // A garbage prefix: only a restart-from-0 can produce the pinned hash.
      fs.writeFileSync(path.join(modelsDir, 'test-model.bin.part'), makeBody(1 * MB, 99));

      yield* manager.download('test-model');
      yield* waitFor(manager, s => modelOf(s, 'test-model').installed);
      assert.deepStrictEqual(fixture.requests, [{ path: '/model.bin', range: `bytes=${1 * MB}-` }]);
      assert.strictEqual(fileSha1(path.join(modelsDir, 'test-model.bin')), entry.sha1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a kept .part whose bytes no longer match upstream fails the SHA-1 backstop, is discarded, and the retry installs clean', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const body = makeBody(2 * MB, 21);
      fixture.behaviour.body = body;
      const entry = entryFor(fixture.url, body);
      const modelsDir = freshDir();
      // A garbage prefix from an earlier boot against a since-changed upstream:
      // the blind resume cannot detect it up front (no etag memory survives a
      // restart) — the streaming SHA-1 over prefix+tail is the backstop.
      fs.mkdirSync(modelsDir, { recursive: true });
      fs.writeFileSync(path.join(modelsDir, 'test-model.bin.part'), makeBody(512 * 1024, 99));
      const { layer, logger } = build({ catalogue: [entry], modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);
      yield* awaitBootReconcile(logger);
      assert.isTrue(exists(path.join(modelsDir, 'test-model.bin.part')));

      yield* manager.download('test-model');
      const errored = yield* waitFor(
        manager,
        s => modelOf(s, 'test-model').download?.status === 'error'
      );
      assert.strictEqual(modelOf(errored, 'test-model').download?.error, 'checksum-mismatch');
      assert.isFalse(
        exists(path.join(modelsDir, 'test-model.bin.part')),
        'the poisoned prefix is discarded'
      );

      // The retry starts clean from 0 and installs.
      yield* manager.download('test-model');
      yield* waitFor(manager, s => modelOf(s, 'test-model').installed);
      assert.isNull(fixture.requests.at(-1)?.range, 'no Range on the clean retry');
      assert.strictEqual(fileSha1(path.join(modelsDir, 'test-model.bin')), entry.sha1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('refuses a download that does not fit (statfs + 10% headroom): typed, published, no request', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const body = makeBody(1 * MB, 9);
      fixture.behaviour.body = body;
      const entry = entryFor(fixture.url, body);
      const modelsDir = freshDir();
      // Exactly the file size free: the 10% headroom makes it insufficient.
      let free = body.length;
      const { layer, logger } = build({ catalogue: [entry], modelsDir, freeBytes: () => free });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);

      const refused = yield* Effect.exit(manager.download('test-model'));
      assert.isTrue(Exit.isFailure(refused));
      if (Exit.isFailure(refused)) assert.include(JSON.stringify(refused.cause), 'insufficient-space');
      const view = modelOf(yield* manager.list, 'test-model');
      assert.strictEqual(view.download?.status, 'error');
      assert.strictEqual(view.download?.error, 'insufficient-space');
      assert.strictEqual(fixture.requests.length, 0, 'refused before any request');
      assert.isFalse(exists(path.join(modelsDir, 'test-model.bin.part')));
      assert.isDefined(
        logger.find(e => e.message === 'model download refused: insufficient space')
      );

      // With headroom available the same call proceeds and replaces the error.
      free = Math.ceil(body.length * 1.1);
      yield* manager.download('test-model');
      yield* waitFor(manager, s => modelOf(s, 'test-model').installed);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('delete cancels/unlinks/forgets and republishes; unknown ids are typed', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const body = makeBody(1 * MB, 10);
      fixture.behaviour.body = body;
      const entry = entryFor(fixture.url, body);
      const modelsDir = freshDir();
      const { layer, db } = build({ catalogue: [entry], modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);

      yield* manager.download('test-model');
      yield* waitFor(manager, s => modelOf(s, 'test-model').installed);
      const final = path.join(modelsDir, 'test-model.bin');
      assert.isTrue(exists(final));

      yield* manager.delete('test-model');
      assert.isFalse(exists(final));
      assert.isUndefined(db.localModels.get('test-model'));
      assert.isFalse(modelOf(yield* manager.list, 'test-model').installed);
      assert.isTrue(Option.isNone(yield* manager.installedPath('test-model')));
      // Idempotent on an already-deleted model; typed on an unknown id.
      yield* manager.delete('test-model');
      const unknown = yield* Effect.exit(manager.delete('nope'));
      assert.isTrue(Exit.isFailure(unknown));
      if (Exit.isFailure(unknown)) assert.include(JSON.stringify(unknown.cause), 'unknown-model');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a whisper install auto-downloads the VAD entry once — an installed VAD is left alone', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const body = makeBody(1 * MB, 22);
      fixture.behaviour.body = body;
      const whisper = entryFor(fixture.url, body);
      // The fixture serves the same body on every path, so both pins verify.
      const vad = entryFor(fixture.url, body, {
        id: 'vad-model',
        filename: 'vad-model.bin',
        downloadUrl: `${fixture.url}/vad.bin`,
        kind: 'vad',
        recommended: false,
      });
      const modelsDir = freshDir();
      const { layer, db, logger } = build({ catalogue: [whisper, vad], modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);

      // ONE explicit download; the VAD weights ride along.
      yield* manager.download('test-model');
      yield* waitFor(
        manager,
        s => modelOf(s, 'test-model').installed && modelOf(s, 'vad-model').installed
      );
      assert.strictEqual(fileSha1(path.join(modelsDir, 'vad-model.bin')), vad.sha1);
      assert.isDefined(db.localModels.get('test-model'));
      assert.isDefined(db.localModels.get('vad-model'));
      assert.deepStrictEqual(
        fixture.requests.map(r => r.path),
        ['/model.bin', '/vad.bin']
      );
      assert.isDefined(logger.find(e => e.message === 'vad model auto-download started'));

      // With the VAD installed, the next whisper install kicks nothing.
      yield* manager.delete('test-model');
      yield* manager.download('test-model');
      yield* waitFor(manager, s => modelOf(s, 'test-model').installed);
      assert.deepStrictEqual(
        fixture.requests.map(r => r.path),
        ['/model.bin', '/vad.bin', '/model.bin']
      );
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a VAD auto-download failure surfaces on the VAD row only — the whisper install stands', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const body = makeBody(1 * MB, 23);
      fixture.behaviour.body = body;
      const whisper = entryFor(fixture.url, body);
      // A wrong pin: the auto-kicked VAD download dies at verify.
      const vad = entryFor(fixture.url, body, {
        id: 'vad-model',
        filename: 'vad-model.bin',
        downloadUrl: `${fixture.url}/vad.bin`,
        kind: 'vad',
        recommended: false,
        sha1: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
      });
      const modelsDir = freshDir();
      const { layer, db } = build({ catalogue: [whisper, vad], modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);

      yield* manager.download('test-model');
      const settled = yield* waitFor(
        manager,
        s =>
          modelOf(s, 'test-model').installed &&
          modelOf(s, 'vad-model').download?.status === 'error'
      );
      assert.strictEqual(modelOf(settled, 'vad-model').download?.error, 'checksum-mismatch');
      assert.isFalse(modelOf(settled, 'vad-model').installed);
      assert.isDefined(db.localModels.get('test-model'), 'the whisper install stands');
      assert.isUndefined(db.localModels.get('vad-model'));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('cancel while the fiber awaits response headers clears the entry and removes the .part — never a terminal cancelling', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const body = makeBody(2 * MB, 24);
      fixture.behaviour.body = body;
      fixture.behaviour.stallHeaders = true;
      const entry = entryFor(fixture.url, body);
      const modelsDir = freshDir();
      fs.mkdirSync(modelsDir, { recursive: true });
      const prefix = 256 * 1024;
      const part = path.join(modelsDir, 'test-model.bin.part');
      fs.writeFileSync(part, body.subarray(0, prefix));
      const { layer, logger } = build({ catalogue: [entry], modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);
      yield* awaitBootReconcile(logger);

      yield* manager.download('test-model');
      // The verb published `downloading` and forked; the fiber is now parked
      // INSIDE fetch, awaiting response headers the fixture never sends —
      // the pre-transfer phase the streaming-window interrupt never covered.
      yield* awaitUntil(() => fixture.requests.length === 1, 'the ranged request');
      assert.strictEqual(fixture.requests[0]?.range, `bytes=${prefix}-`);
      assert.strictEqual(
        modelOf(yield* manager.list, 'test-model').download?.status,
        'downloading'
      );

      // Cancel outside the streaming window: the whole-fiber finalizer still
      // clears the entry and removes the .part (the cancel contract).
      yield* manager.cancel('test-model');
      const after = modelOf(yield* manager.list, 'test-model');
      assert.isNull(after.download, 'cancel resolved the entry — not stuck in cancelling');
      assert.isFalse(after.installed);
      assert.isFalse(exists(part), 'cancel removed the .part');
      assert.isDefined(logger.find(e => e.message === 'model download cancelled'));

      // The row is fully retryable: a fresh download starts clean and installs.
      fixture.behaviour.stallHeaders = false;
      yield* manager.download('test-model');
      yield* waitFor(manager, s => modelOf(s, 'test-model').installed);
      assert.isNull(fixture.requests.at(-1)?.range, 'clean start — the .part was gone');
      assert.strictEqual(fileSha1(path.join(modelsDir, 'test-model.bin')), entry.sha1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a transient 429 to the ranged resume keeps the .part untouched and the retry resumes it', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const body = makeBody(2 * MB, 25);
      fixture.behaviour.body = body;
      const entry = entryFor(fixture.url, body);
      const modelsDir = freshDir();
      fs.mkdirSync(modelsDir, { recursive: true });
      const prefix = 512 * 1024;
      const part = path.join(modelsDir, 'test-model.bin.part');
      fs.writeFileSync(part, body.subarray(0, prefix));
      const { layer, logger } = build({ catalogue: [entry], modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);
      yield* awaitBootReconcile(logger);

      // A throttle/refusal to the ranged GET is NOT a changed resource: the
      // kept prefix must survive byte-for-byte for the retry to resume.
      fixture.behaviour.rangedStatus = 429;
      yield* manager.download('test-model');
      const errored = yield* waitFor(
        manager,
        s => modelOf(s, 'test-model').download?.status === 'error'
      );
      assert.strictEqual(modelOf(errored, 'test-model').download?.error, 'network');
      assert.isTrue(exists(part), 'a transient non-2xx keeps the resumable prefix');
      assert.strictEqual(fs.statSync(part).size, prefix, 'the prefix was not truncated');

      // The throttle lifts: the retry resumes from the SAME offset and installs.
      fixture.behaviour.rangedStatus = null;
      yield* manager.download('test-model');
      yield* waitFor(manager, s => modelOf(s, 'test-model').installed);
      assert.deepStrictEqual(
        fixture.requests.map(r => r.range),
        [`bytes=${prefix}-`, `bytes=${prefix}-`]
      );
      assert.strictEqual(fileSha1(path.join(modelsDir, 'test-model.bin')), entry.sha1);
      assert.isFalse(exists(part));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a 416 to the ranged resume is definitive: the .part is truncated and the download restarts from 0', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const body = makeBody(1 * MB, 26);
      fixture.behaviour.body = body;
      const entry = entryFor(fixture.url, body);
      const modelsDir = freshDir();
      fs.mkdirSync(modelsDir, { recursive: true });
      // A stale prefix LONGER than the (since-shrunk) resource: the ranged GET
      // starts beyond the end, so the origin answers 416.
      const stale = body.length + 4096;
      fs.writeFileSync(path.join(modelsDir, 'test-model.bin.part'), makeBody(stale, 99));
      const { layer, logger } = build({ catalogue: [entry], modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);
      yield* awaitBootReconcile(logger);

      yield* manager.download('test-model');
      yield* waitFor(manager, s => modelOf(s, 'test-model').installed);
      assert.deepStrictEqual(
        fixture.requests.map(r => r.range),
        [`bytes=${stale}-`, null]
      );
      assert.isDefined(logger.find(e => e.message === 'model download restarting from 0'));
      assert.strictEqual(fileSha1(path.join(modelsDir, 'test-model.bin')), entry.sha1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a pre-flight io failure is published as an error entry — the fire-and-forget renderer always sees an outcome', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const body = makeBody(1024, 27);
      const entry = entryFor('http://unused', body);
      const modelsDir = freshDir();
      // The models DIR path exists as a FILE: the pre-flight mkdir fails typed
      // BEFORE the fiber forks and before any other state is published.
      fs.writeFileSync(modelsDir, 'not a directory');
      const { layer } = build({ catalogue: [entry], modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);

      const refused = yield* Effect.exit(manager.download('test-model'));
      assert.isTrue(Exit.isFailure(refused));
      if (Exit.isFailure(refused)) {
        assert.include(JSON.stringify(refused.cause), '"reason":"io"');
      }
      const view = modelOf(yield* manager.list, 'test-model');
      assert.strictEqual(view.download?.status, 'error');
      assert.strictEqual(view.download?.error, 'io');
      yield* Scope.close(scope, Exit.void);
    })
  );
});

describe('ModelManager reconcile', () => {
  const rowFor = (entry: ModelCatalogueEntry, dir: string, sizeBytes: number): LocalModelRow => ({
    modelId: entry.id,
    filename: entry.filename,
    path: path.join(dir, entry.filename),
    sizeBytes,
    checksum: entry.sha1,
    downloadedAt: '2026-09-01T00:00:00.000Z',
    verifiedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  });

  it.effect(
    'row without file → removed; truncated file → removed; catalogue file without row → adopted only when SHA-1 verifies; unknown .part → deleted; catalogue-named .part → kept',
    () =>
      Effect.gen(function* () {
        const modelsDir = freshDir();
        fs.mkdirSync(modelsDir, { recursive: true });
        const good = makeBody(64 * 1024, 11);
        const bad = makeBody(64 * 1024, 12);
        const catalogue: ModelCatalogueEntry[] = [
          entryFor('http://unused', good, { id: 'verified', filename: 'verified.bin' }),
          entryFor('http://unused', good, { id: 'corrupt', filename: 'corrupt.bin' }),
          entryFor('http://unused', good, { id: 'missing', filename: 'missing.bin' }),
          entryFor('http://unused', good, { id: 'truncated', filename: 'truncated.bin' }),
        ];
        fs.writeFileSync(path.join(modelsDir, 'verified.bin'), good);
        fs.writeFileSync(path.join(modelsDir, 'corrupt.bin'), bad);
        fs.writeFileSync(path.join(modelsDir, 'truncated.bin'), good.subarray(0, 1000));
        // 'stale.bin' names no catalogue entry ⇒ deleted; 'missing.bin.part'
        // is a resumable prefix for the 'missing' entry ⇒ kept.
        fs.writeFileSync(path.join(modelsDir, 'stale.bin.part'), bad);
        fs.writeFileSync(path.join(modelsDir, 'missing.bin.part'), good.subarray(0, 500));
        const rows = [
          rowFor(catalogue[2], modelsDir, good.length),
          rowFor(catalogue[3], modelsDir, good.length),
          // A row for an id no longer in the catalogue is dropped too.
          { ...rowFor(catalogue[0], modelsDir, 1), modelId: 'retired', filename: 'retired.bin' },
        ];
        const { layer, db, logger } = build({ catalogue, modelsDir, rows });
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        const manager = Context.get(ctx, ModelManager);

        // Boot: the rows load as-is (no disk work on the acquire path)…
        assert.isTrue(modelOf(yield* manager.list, 'missing').installed);
        // …then the forked reconcile settles.
        yield* awaitBootReconcile(logger);
        const report = logger.find(e => e.message === RECONCILED)?.data;
        assert.deepStrictEqual(report, { removed: 3, adopted: 1, partsDeleted: 1 });

        assert.deepStrictEqual([...db.localModels.keys()], ['verified']);
        const state = yield* manager.list;
        assert.isTrue(modelOf(state, 'verified').installed);
        assert.isFalse(modelOf(state, 'corrupt').installed);
        assert.isFalse(modelOf(state, 'missing').installed);
        assert.isFalse(modelOf(state, 'truncated').installed);
        assert.isTrue(exists(path.join(modelsDir, 'corrupt.bin')), 'an unverified file is left alone');
        assert.isFalse(exists(path.join(modelsDir, 'stale.bin.part')));
        assert.isTrue(
          exists(path.join(modelsDir, 'missing.bin.part')),
          'a catalogue-named .part is kept for blind resume'
        );
        assert.isDefined(
          logger.find(e => e.message === 'catalogue file present but unverified — not adopted')
        );
        assert.deepStrictEqual(
          yield* manager.installedPath('verified'),
          Option.some(path.join(modelsDir, 'verified.bin'))
        );
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect('tolerates a missing models dir (boot never blocks): rows without files drop, no mkdir', () =>
    Effect.gen(function* () {
      const modelsDir = freshDir();
      const good = makeBody(1024, 13);
      const catalogue = [entryFor('http://unused', good, { id: 'gone', filename: 'gone.bin' })];
      const { layer, db, logger } = build({
        catalogue,
        modelsDir,
        rows: [rowFor(catalogue[0], modelsDir, good.length)],
      });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);
      yield* awaitBootReconcile(logger);
      assert.deepStrictEqual(logger.find(e => e.message === RECONCILED)?.data, {
        removed: 1,
        adopted: 0,
        partsDeleted: 0,
      });
      assert.strictEqual(db.localModels.size, 0);
      assert.isFalse(modelOf(yield* manager.list, 'gone').installed);
      assert.isFalse(exists(modelsDir), 'reconcile never creates the dir');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect("leaves a live download's .part alone", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const body = makeBody(4 * MB, 14);
      fixture.behaviour.body = body;
      fixture.behaviour.stallAfter = 1 * MB;
      const entry = entryFor(fixture.url, body);
      const modelsDir = freshDir();
      const { layer } = build({ catalogue: [entry], modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);
      const part = path.join(modelsDir, 'test-model.bin.part');

      yield* manager.download('test-model');
      yield* waitFor(manager, s => (modelOf(s, 'test-model').download?.bytesDownloaded ?? 0) > 0);
      yield* awaitUntil(() => exists(part), '.part');
      const report = yield* manager.reconcile;
      assert.deepStrictEqual(report, { removed: 0, adopted: 0, partsDeleted: 0 });
      assert.isTrue(exists(part));
      yield* manager.cancel('test-model');
      assert.isFalse(exists(part));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('the removed delta spares a row a download installed while reconcile ran (scan → install → apply)', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const body = makeBody(1 * MB, 31);
      fixture.behaviour.body = body;
      const modelsDir = freshDir();
      fs.mkdirSync(modelsDir, { recursive: true });
      const target = entryFor(fixture.url, body);
      // An adoption candidate whose (gated) upsert parks the boot reconcile
      // between its scan pass and its delta apply — a deterministic race window.
      const adoptBody = makeBody(64 * 1024, 32);
      const adoptable = entryFor(fixture.url, adoptBody, {
        id: 'adoptable',
        filename: 'adoptable.bin',
        recommended: false,
      });
      fs.writeFileSync(path.join(modelsDir, 'adoptable.bin'), adoptBody);
      const reached = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const logger = makeTestLogger();
      // A STALE row for test-model (its file is missing): the scan removes it.
      const db = makeFakeOperationalDb(
        {},
        { localModels: [rowFor(target, modelsDir, body.length)] }
      );
      const gatedDb = Layer.map(db.layer, context => {
        const service = Context.get(context, OperationalDb);
        return Context.make(OperationalDb, {
          ...service,
          upsertLocalModel: row =>
            row.modelId === 'adoptable'
              ? Deferred.succeed(reached, undefined).pipe(
                  Effect.zipRight(Deferred.await(gate)),
                  Effect.zipRight(service.upsertLocalModel(row))
                )
              : service.upsertLocalModel(row),
        });
      });
      const layer = makeModelManagerLive({
        catalogue: [target, adoptable],
        probe: { freeBytes: async () => Number.MAX_SAFE_INTEGER },
      }).pipe(
        Layer.provide(testConfigLayer({ modelsDir })),
        Layer.provide(gatedDb),
        Layer.provide(Layer.succeed(PendingReset, { applied: null })),
        Layer.provide(logger.layer)
      );
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);

      // The boot reconcile has scanned (the stale row is in its removed delta)
      // and is now parked inside the adopt pass on the gated upsert…
      yield* Deferred.await(reached);
      // …while a real download of the removed model completes fully.
      yield* manager.download('test-model');
      yield* waitFor(manager, s => modelOf(s, 'test-model').installed);
      yield* Deferred.succeed(gate, undefined);
      yield* awaitBootReconcile(logger);
      assert.deepStrictEqual(logger.find(e => e.message === RECONCILED)?.data, {
        removed: 1,
        adopted: 1,
        partsDeleted: 0,
      });

      // The delta apply re-checked the row: the fresh install survived.
      const state = yield* manager.list;
      assert.isTrue(
        modelOf(state, 'test-model').installed,
        'the fresh row survived the removed delta'
      );
      assert.isTrue(modelOf(state, 'adoptable').installed);
      assert.isDefined(db.localModels.get('test-model'));
      assert.deepStrictEqual(
        yield* manager.installedPath('test-model'),
        Option.some(path.join(modelsDir, 'test-model.bin'))
      );
      yield* Scope.close(scope, Exit.void);
    })
  );
});
