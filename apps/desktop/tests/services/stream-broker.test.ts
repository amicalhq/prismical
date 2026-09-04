import { assert, describe, it } from '@effect/vitest';
import { streamPortChannel, type TransportResponse } from '@prismical/desktop-contracts';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import { vi } from 'vitest';
import type { FakeElectron, FakeMessagePortMain } from '../helpers/fake-electron';
import { FakeWebContents } from '../helpers/fake-electron';
import { makeTestLogger, recordingLaneStub } from '../helpers/test-layers';
import { StreamBroker, type StreamPortSender } from '../../src/main/domains/streams/service';
import { StreamBrokerLive } from '../../src/main/domains/streams/live';
import { WorkspaceTransport, type WorkspaceBackendApi } from '../../src/main/domains/transport/service';
import { WorkspaceTransportLive } from '../../src/main/domains/transport/live';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());
// Imported for the mock's side effects (MessageChannelMain).
void ((await import('electron')) as unknown as FakeElectron);

// The producer forwards a real fetch Response body — reads + FakeMessagePortMain
// delivery are microtask-driven (no Effect.sleep), so drive them by flushing the
// microtask queue rather than a TestClock.
const settle = Effect.gen(function* () {
  for (let i = 0; i < 16; i++) {
    yield* Effect.yieldNow();
    yield* Effect.promise(() => new Promise<void>(resolve => queueMicrotask(resolve)));
  }
});

/** A controllable SSE Response the fake WorkspaceBackend hands to the producer. */
const makeSseSource = () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
    },
    cancel() {
      cancelled = true;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    // Tolerant: enqueuing after the reader cancelled the stream is a no-op (the
    // abort test pushes again to prove nothing more crosses the port).
    push: (text: string): void => {
      try {
        controller?.enqueue(encoder.encode(text));
      } catch {
        // Stream already cancelled/closed.
      }
    },
    close: (): void => {
      try {
        controller?.close();
      } catch {
        // Already closed.
      }
    },
    get cancelled(): boolean {
      return cancelled;
    },
  };
};

const INTERNAL: TransportResponse = { error: { code: 'INTERNAL' } };

/** A fake WorkspaceBackend whose openAskStream yields `source`, recording the body. */
const clientReturning = (
  source: { response: Response },
  onOpen?: (body: unknown) => void
): WorkspaceBackendApi => ({
  request: () => Effect.succeed(INTERNAL),
  openAskStream: body => {
    onOpen?.(body);
    return Effect.succeed(source.response);
  },
  collabToken: Effect.succeed('STUB-ID-TOKEN'),
  ...recordingLaneStub,
});

interface Harness {
  sender: FakeWebContents;
  rendererPort: (streamId: string) => FakeMessagePortMain;
  received: (streamId: string) => unknown[];
  mainPort: (streamId: string) => FakeMessagePortMain | undefined;
}

const makeHarness = (): Harness => {
  const sender = new FakeWebContents();
  const receivedByStream = new Map<string, unknown[]>();
  const ports = new Map<string, FakeMessagePortMain>();
  const rendererPort = (streamId: string): FakeMessagePortMain => {
    const existing = ports.get(streamId);
    if (existing) return existing;
    const posted = sender.posted.find(p => p.channel === streamPortChannel(streamId));
    if (!posted) throw new Error(`no port posted for ${streamId}`);
    const port = posted.transfer[0];
    if (!port) throw new Error('no transferred port');
    const received: unknown[] = [];
    receivedByStream.set(streamId, received);
    port.on('message', (event: { data: unknown }) => {
      received.push(event.data);
    });
    ports.set(streamId, port);
    return port;
  };
  return {
    sender,
    rendererPort,
    received: streamId => receivedByStream.get(streamId) ?? [],
    // The transferred port is port2; its peer is the main-side port1.
    mainPort: streamId =>
      sender.posted.find(p => p.channel === streamPortChannel(streamId))?.transfer[0]?.peer ??
      undefined,
  };
};

const buildBroker = (logger: ReturnType<typeof makeTestLogger>, scope: Scope.Scope) =>
  Effect.gen(function* () {
    // ONE WorkspaceTransport reference: shared with the broker AND exposed so the test
    // registers the session's client into the SAME accessor the broker reads.
    const ct = WorkspaceTransportLive;
    const layer = Layer.mergeAll(
      StreamBrokerLive.pipe(Layer.provide(logger.layer), Layer.provide(ct)),
      ct
    );
    const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
    return {
      broker: Context.get(ctx, StreamBroker),
      transport: Context.get(ctx, WorkspaceTransport),
    };
  });

const bytesOf = (received: unknown[]): Uint8Array[] =>
  received.filter((m): m is Uint8Array => m instanceof Uint8Array);

const textOf = (received: unknown[]): string =>
  bytesOf(received)
    .map(b => new TextDecoder().decode(b))
    .join('');

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

const SSE_START = 'data: {"type":"start"}\n\n';
const SSE_DELTA = 'data: {"type":"text-delta","id":"t1","delta":"hi"}\n\n';
const SSE_DONE = 'data: [DONE]\n\n';

describe('StreamBroker Ask lane', () => {
  it.effect('forwards server SSE bytes verbatim → done marker; completed and port closed', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const { broker, transport } = yield* buildBroker(logger, scope);
      const harness = makeHarness();
      const source = makeSseSource();
      const bodies: unknown[] = [];
      yield* transport
        .register(clientReturning(source, body => bodies.push(body)))
        .pipe(Scope.extend(scope));

      yield* broker.open({
        streamId: ID_A,
        sender: harness.sender as unknown as StreamPortSender,
        body: { messages: [{ role: 'user', content: 'hi' }] },
      });
      harness.rendererPort(ID_A);

      source.push(SSE_START);
      source.push(SSE_DELTA);
      source.push(SSE_DONE);
      source.close();
      yield* settle;

      // The renderer-built body reached the WorkspaceBackend, and the SSE crossed the
      // port unchanged (no reframing / NDJSON / chunk translation).
      assert.deepStrictEqual(bodies, [{ messages: [{ role: 'user', content: 'hi' }] }]);
      assert.strictEqual(textOf(harness.received(ID_A)), `${SSE_START}${SSE_DELTA}${SSE_DONE}`);
      assert.deepStrictEqual(harness.received(ID_A).at(-1), { type: 'done' });

      const stats = yield* broker.stats;
      assert.strictEqual(stats.opened, 1);
      assert.strictEqual(stats.completed, 1);
      assert.strictEqual(stats.aborted, 0);
      assert.strictEqual(stats.active, 0);
      assert.isTrue(harness.mainPort(ID_A)?.closed, 'the main-side port closed at the end');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('renderer abort interrupts the producer, cancels the SSE reader, closes the port', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const { broker, transport } = yield* buildBroker(logger, scope);
      const harness = makeHarness();
      const source = makeSseSource();
      yield* transport.register(clientReturning(source)).pipe(Scope.extend(scope));

      yield* broker.open({
        streamId: ID_A,
        sender: harness.sender as unknown as StreamPortSender,
        body: {},
      });
      const port = harness.rendererPort(ID_A);
      source.push(SSE_START); // one chunk out, stream still open
      yield* settle;
      assert.isAbove(bytesOf(harness.received(ID_A)).length, 0);

      port.postMessage({ type: 'abort' });
      yield* settle;

      const stats = yield* broker.stats;
      assert.strictEqual(stats.aborted, 1);
      assert.strictEqual(stats.active, 0);
      assert.isTrue(source.cancelled, 'abort cancelled the SSE reader (server connection dropped)');
      assert.isTrue(harness.mainPort(ID_A)?.closed, 'the main-side port closed on abort');

      // No further bytes after the abort, even if the source keeps pushing.
      const count = harness.received(ID_A).length;
      source.push(SSE_DELTA);
      yield* settle;
      assert.strictEqual(harness.received(ID_A).length, count);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('port close (renderer gone) interrupts the producer and cancels the reader', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const { broker, transport } = yield* buildBroker(logger, scope);
      const harness = makeHarness();
      const source = makeSseSource();
      yield* transport.register(clientReturning(source)).pipe(Scope.extend(scope));

      yield* broker.open({
        streamId: ID_B,
        sender: harness.sender as unknown as StreamPortSender,
        body: {},
      });
      const port = harness.rendererPort(ID_B);
      source.push(SSE_START);
      yield* settle;

      port.close();
      yield* settle;

      const stats = yield* broker.stats;
      assert.strictEqual(stats.aborted, 1);
      assert.strictEqual(stats.active, 0);
      assert.isTrue(source.cancelled, 'the SSE reader was cancelled on port close');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('no live session (WorkspaceTransport None) → clean termination, no bytes, port closed', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const { broker } = yield* buildBroker(logger, scope);
      const harness = makeHarness();

      // No client registered → coreTransport.current is None.
      yield* broker.open({
        streamId: ID_A,
        sender: harness.sender as unknown as StreamPortSender,
        body: {},
      });
      harness.rendererPort(ID_A);
      yield* settle;

      assert.strictEqual(bytesOf(harness.received(ID_A)).length, 0, 'no SSE bytes without a session');
      const stats = yield* broker.stats;
      assert.strictEqual(stats.completed, 1, 'terminated cleanly (never threw)');
      assert.strictEqual(stats.active, 0);
      assert.isTrue(harness.mainPort(ID_A)?.closed, 'the port closed so the renderer settles');
      assert.isDefined(
        logger.find(e => e.level === 'warn' && e.message.includes('no live session'))
      );
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('resume messages are accepted (seam wired) without disrupting the stream', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const { broker, transport } = yield* buildBroker(logger, scope);
      const harness = makeHarness();
      const source = makeSseSource();
      yield* transport.register(clientReturning(source)).pipe(Scope.extend(scope));

      yield* broker.open({
        streamId: ID_A,
        sender: harness.sender as unknown as StreamPortSender,
        body: {},
      });
      const port = harness.rendererPort(ID_A);
      source.push(SSE_START);
      yield* settle;

      // Resume seam: a valid inbound resume parses without a warning and the
      // stream survives (the producer does not block on it — resume rides a fresh
      // POST via DefaultChatTransport).
      port.postMessage({ type: 'resume', parts: [{ type: 'tool-result' }, { type: 'text' }] });
      yield* settle;
      assert.isUndefined(
        logger.find(e => e.level === 'warn' && e.message === 'invalid stream port message ignored')
      );
      assert.strictEqual((yield* broker.stats).active, 1, 'the stream survived the resume message');

      source.close();
      yield* settle;
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('scope close interrupts in-flight streams and closes their ports', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const { broker, transport } = yield* buildBroker(logger, scope);
      const harness = makeHarness();
      const source = makeSseSource();
      yield* transport.register(clientReturning(source)).pipe(Scope.extend(scope));

      yield* broker.open({
        streamId: ID_A,
        sender: harness.sender as unknown as StreamPortSender,
        body: {},
      });
      harness.rendererPort(ID_A);
      source.push(SSE_START); // producer is mid-forward (source stays open)
      yield* settle;
      const mainPort = harness.mainPort(ID_A);
      assert.isDefined(mainPort);

      yield* Scope.close(scope, Exit.void);
      yield* settle;
      assert.isTrue(mainPort?.closed, 'producer cleanup closed the main-side port');
      assert.isTrue(source.cancelled, 'the SSE reader was cancelled on teardown');
    })
  );

  it.effect('duplicate stream ids are rejected typed', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const { broker, transport } = yield* buildBroker(logger, scope);
      const harness = makeHarness();
      const source = makeSseSource();
      yield* transport.register(clientReturning(source)).pipe(Scope.extend(scope));

      yield* broker.open({
        streamId: ID_A,
        sender: harness.sender as unknown as StreamPortSender,
        body: {},
      });
      const second = yield* Effect.exit(
        broker.open({
          streamId: ID_A,
          sender: harness.sender as unknown as StreamPortSender,
          body: {},
        })
      );
      assert.isTrue(Exit.isFailure(second));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('invalid port messages are ignored with a warn (stream survives)', () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const { broker, transport } = yield* buildBroker(logger, scope);
      const harness = makeHarness();
      const source = makeSseSource();
      yield* transport.register(clientReturning(source)).pipe(Scope.extend(scope));

      yield* broker.open({
        streamId: ID_B,
        sender: harness.sender as unknown as StreamPortSender,
        body: {},
      });
      const port = harness.rendererPort(ID_B);
      source.push(SSE_START); // keep the stream open/active
      yield* settle;

      port.postMessage({ type: 'evil', payload: 'x' });
      yield* settle;
      assert.isDefined(
        logger.find(e => e.level === 'warn' && e.message === 'invalid stream port message ignored')
      );
      assert.strictEqual((yield* broker.stats).active, 1, 'stream survived the garbage message');

      source.close();
      yield* settle;
      yield* Scope.close(scope, Exit.void);
    })
  );
});
