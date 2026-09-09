/**
 * CollabBroker unit tests: log replay and hydrated marker,
 * append + relay-to-others (never echo), flush/compact dispatch, invalid
 * inbound messages dropped, NO_WORKSPACE / DUPLICATE envelopes, port-close
 * deregistration, workspace-swap degradation, and scope-close port cleanup.
 * Fake-sender/port idiom follows tests/services/stream-broker.test.ts.
 */
import { assert, describe, it } from '@effect/vitest';
import { collabPortChannel } from '@prismical/desktop-contracts';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import { vi } from 'vitest';
import type { FakeElectron, FakeMessagePortMain } from '../helpers/fake-electron';
import { FakeWebContents } from '../helpers/fake-electron';
import { makeTestLogger } from '../helpers/test-layers';
import { CollabBrokerLive } from '../../src/main/domains/collab/live';
import {
  CollabBroker,
  CollabError,
  type CollabPortSender,
} from '../../src/main/domains/collab/service';
import { CollabBridgeLive } from '../../src/main/domains/collab/store-live';
import {
  CollabBridge,
  type NoteBodyFlush,
  type NoteBodyStoreApi,
} from '../../src/main/domains/collab/store';
import { ProductDbError } from '../../src/main/infra/product-db/service';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());
// Imported for the mock's side effects (MessageChannelMain).
void ((await import('electron')) as unknown as FakeElectron);

// FakeMessagePortMain delivery + the pump fiber are microtask-driven (no
// Effect.sleep), so drive them by flushing the microtask queue.
const settle = Effect.gen(function* () {
  for (let i = 0; i < 16; i++) {
    yield* Effect.yieldNow();
    yield* Effect.promise(() => new Promise<void>(resolve => queueMicrotask(resolve)));
  }
});

/** An in-memory NoteBodyStore recording every call the broker dispatches. */
const makeFakeStore = () => {
  const logs = new Map<string, Array<{ seq: number; update: Uint8Array }>>();
  const flushes: Array<{ noteId: string; content: NoteBodyFlush }> = [];
  const compacts: Array<{ noteId: string; upTo: number; state: Uint8Array }> = [];
  /** Flip to reject every append (a disk-full blip). */
  const flags = { failAppends: false, failFlushes: false };
  const api: NoteBodyStoreApi = {
    listUpdates: noteId => Effect.sync(() => logs.get(noteId) ?? []),
    appendUpdate: (noteId, update) =>
      flags.failAppends
        ? Effect.fail(new ProductDbError({ op: 'note-body-append', cause: 'disk full' }))
        : Effect.sync(() => {
            const log = logs.get(noteId) ?? [];
            const seq = (log[log.length - 1]?.seq ?? 0) + 1;
            log.push({ seq, update });
            logs.set(noteId, log);
            return seq;
          }),
    compact: (noteId, upTo, state) =>
      Effect.sync(() => {
        compacts.push({ noteId, upTo, state });
      }),
    applyFlush: (noteId, content) =>
      flags.failFlushes
        ? Effect.fail(new ProductDbError({ op: 'note-body-flush', cause: 'disk full' }))
        : Effect.sync(() => {
            flushes.push({ noteId, content });
          }),
  };
  return { api, logs, flushes, compacts, flags };
};

interface Harness {
  sender: FakeWebContents;
  rendererPort: (openId: string) => FakeMessagePortMain;
  received: (openId: string) => unknown[];
  mainPort: (openId: string) => FakeMessagePortMain | undefined;
}

const makeHarness = (): Harness => {
  const sender = new FakeWebContents();
  const receivedByOpen = new Map<string, unknown[]>();
  const ports = new Map<string, FakeMessagePortMain>();
  const rendererPort = (openId: string): FakeMessagePortMain => {
    const existing = ports.get(openId);
    if (existing) return existing;
    const posted = sender.posted.find(p => p.channel === collabPortChannel(openId));
    if (!posted) throw new Error(`no port posted for ${openId}`);
    const port = posted.transfer[0];
    if (!port) throw new Error('no transferred port');
    const received: unknown[] = [];
    receivedByOpen.set(openId, received);
    port.on('message', (event: { data: unknown }) => {
      received.push(event.data);
    });
    ports.set(openId, port);
    return port;
  };
  return {
    sender,
    rendererPort,
    received: openId => receivedByOpen.get(openId) ?? [],
    // The transferred port is port2; its peer is the main-side port1.
    mainPort: openId =>
      sender.posted.find(p => p.channel === collabPortChannel(openId))?.transfer[0]?.peer ??
      undefined,
  };
};

const buildBroker = (logger: ReturnType<typeof makeTestLogger>, scope: Scope.Scope) =>
  Effect.gen(function* () {
    // ONE CollabBridge reference: shared with the broker AND exposed so the test
    // registers the workspace's store into the SAME accessor the broker reads.
    const bridge = CollabBridgeLive;
    const layer = Layer.mergeAll(
      CollabBrokerLive.pipe(Layer.provide(logger.layer), Layer.provide(bridge)),
      bridge
    );
    const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
    return {
      broker: Context.get(ctx, CollabBroker),
      bridge: Context.get(ctx, CollabBridge),
    };
  });

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

const blob = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes);

const asSender = (harness: Harness): CollabPortSender =>
  harness.sender as unknown as CollabPortSender;

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit) && exit.cause._tag === 'Fail' ? exit.cause.error : undefined;

describe('CollabBroker note-body log lane', () => {
  it.effect('replays the log in order, then the hydrated marker with the last seq + count', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const { broker, bridge } = yield* buildBroker(logger, scope);
      const store = makeFakeStore();
      store.logs.set('nt_a', [
        { seq: 1, update: blob(1) },
        { seq: 2, update: blob(2) },
      ]);
      yield* bridge.register(store.api).pipe(Scope.extend(scope));
      const harness = makeHarness();

      yield* broker.open({ openId: ID_A, noteId: 'nt_a', sender: asSender(harness) });
      harness.rendererPort(ID_A);
      yield* settle;

      assert.deepStrictEqual(harness.received(ID_A), [
        { type: 'update', data: blob(1) },
        { type: 'update', data: blob(2) },
        { type: 'hydrated', seq: 2, count: 2 },
      ]);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('an empty log hydrates immediately with seq 0 / count 0', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const { broker, bridge } = yield* buildBroker(logger, scope);
      const store = makeFakeStore();
      yield* bridge.register(store.api).pipe(Scope.extend(scope));
      const harness = makeHarness();

      yield* broker.open({ openId: ID_A, noteId: 'nt_a', sender: asSender(harness) });
      harness.rendererPort(ID_A);
      yield* settle;

      assert.deepStrictEqual(harness.received(ID_A), [{ type: 'hydrated', seq: 0, count: 0 }]);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('an update from A is appended and relayed to B only — never echoed to A', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const { broker, bridge } = yield* buildBroker(logger, scope);
      const store = makeFakeStore();
      yield* bridge.register(store.api).pipe(Scope.extend(scope));
      const harness = makeHarness();

      yield* broker.open({ openId: ID_A, noteId: 'nt_a', sender: asSender(harness) });
      yield* broker.open({ openId: ID_B, noteId: 'nt_a', sender: asSender(harness) });
      const portA = harness.rendererPort(ID_A);
      harness.rendererPort(ID_B);
      yield* settle;
      const echoBaseline = harness.received(ID_A).length;

      portA.postMessage({ type: 'update', data: blob(7, 7) });
      yield* settle;

      // Appended to the store…
      assert.deepStrictEqual(store.logs.get('nt_a'), [{ seq: 1, update: blob(7, 7) }]);
      // …relayed VERBATIM to the OTHER port of the same note…
      assert.deepStrictEqual(harness.received(ID_B).at(-1), { type: 'update', data: blob(7, 7) });
      // …and never echoed back to the sender.
      assert.strictEqual(harness.received(ID_A).length, echoBaseline);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a REJECTED append is never relayed — the origin is told to resync', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const { broker, bridge } = yield* buildBroker(logger, scope);
      const store = makeFakeStore();
      yield* bridge.register(store.api).pipe(Scope.extend(scope));
      const harness = makeHarness();

      yield* broker.open({ openId: ID_A, noteId: 'nt_a', sender: asSender(harness) });
      yield* broker.open({ openId: ID_B, noteId: 'nt_a', sender: asSender(harness) });
      const portA = harness.rendererPort(ID_A);
      harness.rendererPort(ID_B);
      yield* settle;
      const bBaseline = harness.received(ID_B).length;

      store.flags.failAppends = true;
      portA.postMessage({ type: 'update', data: blob(4) });
      yield* settle;

      // The blob is not durable, so the peer must NOT get it (a relayed edge
      // no store holds desynchronizes the windows from the log)…
      assert.strictEqual(harness.received(ID_B).length, bBaseline);
      // …and the ORIGIN is asked to re-seed the log it just gapped.
      assert.deepStrictEqual(harness.received(ID_A).at(-1), { type: 'resync' });
      assert.isDefined(logger.find(e => e.message === 'collab update append failed'));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('flush and compact dispatch into the store', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const { broker, bridge } = yield* buildBroker(logger, scope);
      const store = makeFakeStore();
      yield* bridge.register(store.api).pipe(Scope.extend(scope));
      const harness = makeHarness();

      yield* broker.open({ openId: ID_A, noteId: 'nt_a', sender: asSender(harness) });
      const port = harness.rendererPort(ID_A);
      yield* settle;

      port.postMessage({ type: 'flush', text: 'body', markdown: '# body', firstLine: 'body' });
      port.postMessage({ type: 'compact', upTo: 4, state: blob(9) });
      yield* settle;

      assert.deepStrictEqual(store.flushes, [
        { noteId: 'nt_a', content: { text: 'body', markdown: '# body', firstLine: 'body' } },
      ]);
      assert.deepStrictEqual(store.compacts, [{ noteId: 'nt_a', upTo: 4, state: blob(9) }]);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a persistence barrier waits for the preceding flush to finish', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const { broker, bridge } = yield* buildBroker(logger, scope);
      const store = makeFakeStore();
      let release!: () => void;
      const held = new Promise<void>(resolve => {
        release = resolve;
      });
      yield* bridge
        .register({
          ...store.api,
          applyFlush: (noteId, content) =>
            Effect.promise(() => held).pipe(Effect.zipRight(store.api.applyFlush(noteId, content))),
        })
        .pipe(Scope.extend(scope));
      const harness = makeHarness();
      yield* broker.open({ openId: ID_A, noteId: 'nt_a', sender: asSender(harness) });
      const port = harness.rendererPort(ID_A);
      yield* settle;
      port.postMessage({ type: 'flush', text: 'Kept', markdown: 'Kept', firstLine: 'Kept' });
      port.postMessage({ type: 'barrier', requestId: 'wait_1' });
      yield* settle;
      assert.deepStrictEqual(harness.received(ID_A), [{ type: 'hydrated', seq: 0, count: 0 }]);
      release();
      yield* settle;
      assert.lengthOf(store.flushes, 1);
      assert.deepStrictEqual(harness.received(ID_A).at(-1), {
        type: 'barrier',
        requestId: 'wait_1',
        ok: true,
      });
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect(
    'barriers reject failed writes and recover after a snapshot repair and successful flush',
    () =>
      Effect.gen(function* () {
        const logger = makeTestLogger();
        const scope = yield* Scope.make();
        const { broker, bridge } = yield* buildBroker(logger, scope);
        const store = makeFakeStore();
        yield* bridge.register(store.api).pipe(Scope.extend(scope));
        const harness = makeHarness();
        yield* broker.open({ openId: ID_A, noteId: 'nt_a', sender: asSender(harness) });
        const port = harness.rendererPort(ID_A);
        yield* settle;
        store.flags.failAppends = true;
        port.postMessage({ type: 'update', data: blob(1) });
        port.postMessage({ type: 'barrier', requestId: 'failed_append' });
        yield* settle;
        assert.deepStrictEqual(harness.received(ID_A).at(-1), {
          type: 'barrier',
          requestId: 'failed_append',
          ok: false,
        });
        store.flags.failAppends = false;
        store.flags.failFlushes = true;
        port.postMessage({ type: 'compact', upTo: 0, state: blob(1) });
        port.postMessage({ type: 'flush', text: 'Kept', markdown: 'Kept', firstLine: 'Kept' });
        port.postMessage({ type: 'barrier', requestId: 'failed_flush' });
        yield* settle;
        assert.deepStrictEqual(harness.received(ID_A).at(-1), {
          type: 'barrier',
          requestId: 'failed_flush',
          ok: false,
        });
        store.flags.failFlushes = false;
        port.postMessage({ type: 'flush', text: 'Kept', markdown: 'Kept', firstLine: 'Kept' });
        port.postMessage({ type: 'barrier', requestId: 'recovered' });
        yield* settle;
        assert.deepStrictEqual(harness.received(ID_A).at(-1), {
          type: 'barrier',
          requestId: 'recovered',
          ok: true,
        });
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect('invalid inbound messages are warn-logged and dropped — nothing appended', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const { broker, bridge } = yield* buildBroker(logger, scope);
      const store = makeFakeStore();
      yield* bridge.register(store.api).pipe(Scope.extend(scope));
      const harness = makeHarness();

      yield* broker.open({ openId: ID_A, noteId: 'nt_a', sender: asSender(harness) });
      const port = harness.rendererPort(ID_A);
      yield* settle;

      port.postMessage({ type: 'bogus' });
      port.postMessage({ type: 'update', data: 'not-bytes' });
      yield* settle;

      assert.isUndefined(store.logs.get('nt_a'));
      assert.isDefined(logger.find(e => e.message === 'invalid collab port message ignored'));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('no registered store at open → typed NO_WORKSPACE (no port posted)', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const { broker } = yield* buildBroker(logger, scope);
      const harness = makeHarness();

      const exit = yield* Effect.exit(
        broker.open({ openId: ID_A, noteId: 'nt_a', sender: asSender(harness) })
      );
      const failure = failureOf(exit);
      assert.instanceOf(failure, CollabError);
      assert.strictEqual((failure as CollabError).code, 'NO_WORKSPACE');
      assert.strictEqual(harness.sender.posted.length, 0);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a duplicate openId fails typed DUPLICATE', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const { broker, bridge } = yield* buildBroker(logger, scope);
      const store = makeFakeStore();
      yield* bridge.register(store.api).pipe(Scope.extend(scope));
      const harness = makeHarness();

      yield* broker.open({ openId: ID_A, noteId: 'nt_a', sender: asSender(harness) });
      const exit = yield* Effect.exit(
        broker.open({ openId: ID_A, noteId: 'nt_a', sender: asSender(harness) })
      );
      const failure = failureOf(exit);
      assert.instanceOf(failure, CollabError);
      assert.strictEqual((failure as CollabError).code, 'DUPLICATE');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('port close deregisters: a later update no longer relays to the closed peer', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const { broker, bridge } = yield* buildBroker(logger, scope);
      const store = makeFakeStore();
      yield* bridge.register(store.api).pipe(Scope.extend(scope));
      const harness = makeHarness();

      yield* broker.open({ openId: ID_A, noteId: 'nt_a', sender: asSender(harness) });
      yield* broker.open({ openId: ID_B, noteId: 'nt_a', sender: asSender(harness) });
      const portA = harness.rendererPort(ID_A);
      const portB = harness.rendererPort(ID_B);
      yield* settle;

      portB.close();
      yield* settle;
      assert.isTrue(harness.mainPort(ID_B)?.closed, "B's main-side port closed on renderer close");
      const bCount = harness.received(ID_B).length;

      portA.postMessage({ type: 'update', data: blob(5) });
      yield* settle;
      // Still appended for A…
      assert.deepStrictEqual(store.logs.get('nt_a'), [{ seq: 1, update: blob(5) }]);
      // …but nothing more reached the closed B.
      assert.strictEqual(harness.received(ID_B).length, bCount);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect(
    'a workspace swap (bridge → None) degrades appends to warn+drop and keeps relaying',
    () =>
      Effect.gen(function* () {
        const logger = makeTestLogger();
        const scope = yield* Scope.make();
        const { broker, bridge } = yield* buildBroker(logger, scope);
        const store = makeFakeStore();
        const storeScope = yield* Scope.make();
        yield* bridge.register(store.api).pipe(Scope.extend(storeScope));
        const harness = makeHarness();

        yield* broker.open({ openId: ID_A, noteId: 'nt_a', sender: asSender(harness) });
        yield* broker.open({ openId: ID_B, noteId: 'nt_a', sender: asSender(harness) });
        const portA = harness.rendererPort(ID_A);
        harness.rendererPort(ID_B);
        yield* settle;

        // The workspace closes under the live ports.
        yield* Scope.close(storeScope, Exit.void);

        portA.postMessage({ type: 'update', data: blob(3) });
        yield* settle;

        assert.isUndefined(store.logs.get('nt_a'), 'nothing appended after the swap');
        assert.isDefined(
          logger.find(e => e.message === 'collab update append dropped — no workspace')
        );
        // Live windows still converge: the blob relayed to B verbatim.
        assert.deepStrictEqual(harness.received(ID_B).at(-1), { type: 'update', data: blob(3) });
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect('layer-scope close interrupts every open and closes its ports', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const { broker, bridge } = yield* buildBroker(logger, scope);
      const store = makeFakeStore();
      yield* bridge.register(store.api).pipe(Scope.extend(scope));
      const harness = makeHarness();

      yield* broker.open({ openId: ID_A, noteId: 'nt_a', sender: asSender(harness) });
      yield* broker.open({ openId: ID_B, noteId: 'nt_b', sender: asSender(harness) });
      harness.rendererPort(ID_A);
      harness.rendererPort(ID_B);
      yield* settle;

      yield* Scope.close(scope, Exit.void);
      yield* settle;
      assert.isTrue(harness.mainPort(ID_A)?.closed, "A's main-side port closed on scope close");
      assert.isTrue(harness.mainPort(ID_B)?.closed, "B's main-side port closed on scope close");
    })
  );
});
