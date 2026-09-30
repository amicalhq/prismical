import { assert, describe, it } from '@effect/vitest';
import { fileUploadPortChannel, type FileUploadPortMessage } from '@prismical/desktop-contracts';
import { Context, Duration, Effect, Exit, Layer, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { vi } from 'vitest';
import type { FakeMessagePortMain } from '../helpers/fake-electron';
import { FakeWebContents } from '../helpers/fake-electron';
import { makeTestLogger } from '../helpers/test-layers';
import {
  GRANT_TTL,
  MAX_GRANTS,
  UPLOAD_TIMEOUT,
  makeFileUploadBrokerLive,
  type FileUploadDeps,
} from '../../src/main/domains/file-upload/live';
import {
  FileUploadBroker,
  type FileUploadSender,
} from '../../src/main/domains/file-upload/service';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());

/** Port delivery and body reads run on the event loop; wait until `condition` holds. */
const until = (condition: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 1000 && !condition(); i++) {
      yield* Effect.yieldNow;
      yield* Effect.promise(() => new Promise<void>(resolve => setImmediate(resolve)));
    }
    assert.isTrue(condition(), 'condition not reached');
  });

const URL_A = 'https://storage.test/upload/storage/v1/b/bucket/o?upload_id=secret-a';
const URL_B = 'https://storage.test/upload/storage/v1/b/bucket/o?upload_id=secret-b';
const PATH = '/Users/someone/private/meeting.wav';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const FILE = new Uint8Array(200_000).fill(7);

interface Sent {
  readonly url: string;
  readonly init: RequestInit & { readonly duplex: 'half' };
  bytes: number;
}

/**
 * A broker over a fake storage endpoint, with URL_A granted. Storage reads the
 * whole body (so progress fires), then answers `status`; `hold` keeps the
 * response pending until the signal aborts. `abandoned` counts the import's
 * core cancels that main sent.
 */
const setup = (options: { status?: number; hold?: boolean; fail?: 'open' | 'fetch' } = {}) =>
  Effect.gen(function* () {
    const sent: Sent[] = [];
    const deps: FileUploadDeps = {
      openFile: async () => {
        if (options.fail === 'open') throw new Error('ENOENT');
        return new Blob([FILE]);
      },
      fetchFn: async (url, init) => {
        const record: Sent = { url, init, bytes: 0 };
        sent.push(record);
        if (options.fail === 'fetch') throw new TypeError('fetch failed');
        if (options.hold) {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        const reader = (init.body as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          record.bytes += value.byteLength;
        }
        return new Response(null, { status: options.status ?? 200 });
      },
    };
    const logger = makeTestLogger();
    const scope = yield* Scope.make();
    const layer = makeFileUploadBrokerLive(deps).pipe(Layer.provide(logger.layer));
    const broker = Context.get(yield* Layer.build(layer).pipe(Scope.provide(scope)), FileUploadBroker);
    const abandoned = { count: 0 };
    const abandon = Effect.sync(() => {
      abandoned.count++;
    });
    yield* broker.grant(URL_A, abandon);
    const sender = new FakeWebContents();
    const start = (uploadId: string, url = URL_A) =>
      broker.start({
        uploadId,
        url,
        filePath: PATH,
        contentType: 'audio/wav',
        sender: sender as unknown as FileUploadSender,
      });
    /** What main posts on an upload's port (the preload side). */
    const listen = (uploadId: string) => {
      const port = sender.posted.find(p => p.channel === fileUploadPortChannel(uploadId))
        ?.transfer[0];
      if (!port) throw new Error(`no port posted for ${uploadId}`);
      const received: FileUploadPortMessage[] = [];
      port.on('message', (event: { data: FileUploadPortMessage }) => received.push(event.data));
      return { port, received, mainPort: port.peer as FakeMessagePortMain };
    };
    const close = Scope.close(scope, Exit.void);
    return { broker, sent, sender, abandon, abandoned, logger, start, listen, close };
  });

const isDone = (received: FileUploadPortMessage[]) => () => received.at(-1)?.type === 'done';

describe('FileUploadBroker', () => {
  it.effect('sends to a granted URL once, with the file length and type, and reports progress', () =>
    Effect.gen(function* () {
      const { sent, sender, abandoned, logger, start, listen, close } = yield* setup();

      yield* start(ID_A);
      const { received, mainPort } = listen(ID_A);
      yield* until(isDone(received));

      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0]!.url, URL_A);
      assert.strictEqual(sent[0]!.init.method, 'PUT');
      assert.strictEqual(sent[0]!.init.redirect, 'error');
      assert.deepStrictEqual(sent[0]!.init.headers, {
        'Content-Type': 'audio/wav',
        'Content-Length': String(FILE.byteLength),
      });
      assert.strictEqual(sent[0]!.bytes, FILE.byteLength);

      const percents = received.flatMap(m => (m.type === 'progress' ? [m.percent] : []));
      assert.isAbove(percents.length, 0);
      assert.deepStrictEqual(percents, [...percents].sort((a, b) => a - b));
      assert.strictEqual(percents.at(-1), 100);
      assert.deepStrictEqual(received.at(-1), { type: 'done', result: { ok: true } });
      yield* until(() => mainPort.closed);
      assert.strictEqual(abandoned.count, 0, 'a finished upload leaves the import alone');

      // The grant is used up.
      const again = yield* Effect.exit(start(ID_B));
      assert.isTrue(Exit.isFailure(again));
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sender.posted.length, 1);

      // Neither the URL (a storage credential) nor the file path is logged.
      const logged = JSON.stringify(logger.entries);
      assert.notInclude(logged, 'secret-a');
      assert.notInclude(logged, 'meeting.wav');
      yield* close;
    })
  );

  it.effect('refuses a URL that no import response granted', () =>
    Effect.gen(function* () {
      const { sent, sender, start, close } = yield* setup();

      const error = yield* Effect.flip(start(ID_A, URL_B));
      assert.strictEqual(error.code, 'NOT_GRANTED');
      assert.strictEqual(sender.posted.length, 0);
      assert.strictEqual(sent.length, 0);
      yield* close;
    })
  );

  it.effect('refuses an expired grant', () =>
    Effect.gen(function* () {
      const { start, close } = yield* setup();

      yield* TestClock.adjust(Duration.sum(GRANT_TTL, Duration.millis(1)));
      const error = yield* Effect.flip(start(ID_A));
      assert.strictEqual(error.code, 'NOT_GRANTED');
      yield* close;
    })
  );

  it.effect(`keeps only the newest ${MAX_GRANTS} unused grants`, () =>
    Effect.gen(function* () {
      const { broker, abandon, start, close } = yield* setup({ hold: true });
      const urls = Array.from({ length: MAX_GRANTS }, (_, i) => `${URL_B}-${i}`);
      for (const url of urls) yield* broker.grant(url, abandon);

      // URL_A was granted first, so it is the one dropped.
      const oldest = yield* Effect.flip(start(ID_A));
      assert.strictEqual(oldest.code, 'NOT_GRANTED');
      yield* start(ID_B, urls.at(-1));
      yield* close;
    })
  );

  it.effect('refuses a second upload with the same id', () =>
    Effect.gen(function* () {
      const { broker, abandon, start, close } = yield* setup({ hold: true });

      yield* broker.grant(URL_B, abandon);
      yield* start(ID_A);
      const error = yield* Effect.flip(start(ID_A, URL_B));
      assert.strictEqual(error.code, 'DUPLICATE_UPLOAD');
      yield* close;
    })
  );

  for (const [name, options, reason] of [
    ['storage refuses the file', { status: 403 }, 'rejected'],
    ['the file cannot be opened', { fail: 'open' }, 'rejected'],
    ['the connection fails', { fail: 'fetch' }, 'interrupted'],
  ] as const) {
    it.effect(`reports ${reason} when ${name}`, () =>
      Effect.gen(function* () {
        const { start, listen, close } = yield* setup(options);

        yield* start(ID_A);
        const { received } = listen(ID_A);
        yield* until(isDone(received));
        assert.deepStrictEqual(received.at(-1), { type: 'done', result: { ok: false, reason } });
        yield* close;
      })
    );
  }

  it.effect('a cancel message aborts the fetch and reports cancelled', () =>
    Effect.gen(function* () {
      const { sent, abandoned, start, listen, close } = yield* setup({ hold: true });

      yield* start(ID_A);
      const { port, received, mainPort } = listen(ID_A);
      yield* until(() => sent.length === 1);
      assert.isFalse(sent[0]!.init.signal!.aborted);

      port.postMessage({ type: 'cancel' });
      yield* until(isDone(received));
      assert.isTrue(sent[0]!.init.signal!.aborted);
      assert.deepStrictEqual(received.at(-1), {
        type: 'done',
        result: { ok: false, reason: 'cancelled' },
      });
      yield* until(() => mainPort.closed);
      // The page asked for this cancel, so the page cancels the import on core.
      assert.strictEqual(abandoned.count, 0);
      yield* close;
    })
  );

  it.effect('a closed port (page gone) aborts the fetch and cancels the import on core', () =>
    Effect.gen(function* () {
      const { sent, abandoned, start, listen, close } = yield* setup({ hold: true });

      yield* start(ID_A);
      const { port, mainPort } = listen(ID_A);
      yield* until(() => sent.length === 1);

      port.close();
      yield* until(() => abandoned.count === 1);
      assert.isTrue(sent[0]!.init.signal!.aborted);
      assert.isTrue(mainPort.closed);
      yield* close;
    })
  );

  it.effect('an upload past the time budget is interrupted', () =>
    Effect.gen(function* () {
      const { sent, start, listen, close } = yield* setup({ hold: true });

      yield* start(ID_A);
      const { received } = listen(ID_A);
      yield* until(() => sent.length === 1);

      yield* TestClock.adjust(UPLOAD_TIMEOUT);
      yield* until(isDone(received));
      assert.isTrue(sent[0]!.init.signal!.aborted);
      assert.deepStrictEqual(received.at(-1), {
        type: 'done',
        result: { ok: false, reason: 'interrupted' },
      });
      yield* close;
    })
  );
});
