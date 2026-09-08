import { MessageChannelMain, type MessagePortMain } from 'electron';
import {
  parseInboundStreamMessage,
  streamPortChannel,
  type StreamChunk,
} from '@prismical/desktop-contracts';
import { Deferred, Effect, FiberMap, Layer, Option, Queue, Ref } from 'effect';
import { MainLogger } from '../../infra/logging/service';
import { WorkspaceTransport } from '../transport/service';
import { StreamBroker, StreamError, type StreamBrokerApi } from './service';

/**
 * Terminal marker the producer posts on the port after core's SSE body ends
 * normally. The renderer settles its ReadableStream on ANY non-bytes message
 * (bytes are the SSE payload) — so this doubles as the deterministic done
 * signal without racing the port-close event.
 */
const DONE: StreamChunk = { type: 'done' };

interface ResumeMessage {
  readonly parts: ReadonlyArray<unknown>;
}

export const StreamBrokerLive: Layer.Layer<StreamBroker, never, MainLogger | WorkspaceTransport> =
  Layer.scoped(
    StreamBroker,
    Effect.gen(function* () {
      const logger = yield* MainLogger;
      const log = logger.scoped('streams');
      const unsafeLog = logger.scopedSync('streams');
      const coreTransport = yield* WorkspaceTransport;

      // Every producer fiber lands here; layer-scope close interrupts them all
      // (the leak test asserts ports are closed afterwards).
      const fibers = yield* FiberMap.make<string>();
      const opened = yield* Ref.make(0);
      const completed = yield* Ref.make(0);
      const aborted = yield* Ref.make(0);

      /**
       * Forward core's SSE Response body to the port, one Uint8Array chunk at a
       * time, VERBATIM. Interruptible: the canceler cancels the body reader,
       * which aborts the underlying fetch — so an aborted producer drops the
       * connection and core stops the (billable) model call. Completes when the
       * body ends (or errors — a mid-stream failure just terminates the port).
       */
      const forward = (response: Response, port: MessagePortMain): Effect.Effect<void> =>
        Effect.async<void>(resume => {
          const reader = response.body?.getReader();
          if (reader === undefined) {
            resume(Effect.void);
            return;
          }
          let cancelled = false;
          const pump = async (): Promise<void> => {
            try {
              for (;;) {
                const { value, done } = await reader.read();
                if (cancelled) return;
                if (done) {
                  resume(Effect.void);
                  return;
                }
                if (value !== undefined) port.postMessage(value);
              }
            } catch {
              // Stream errored / connection dropped — terminate the port cleanly.
              if (!cancelled) resume(Effect.void);
            }
          };
          void pump();
          return Effect.sync(() => {
            cancelled = true;
            void reader.cancel().catch(() => undefined);
          });
        });

      /**
       * The producer reaches the current session's WorkspaceBackend (None when
       * signed-out / mid-swap → terminate cleanly, never throw), open the real
       * Ask stream and forward its SSE bytes. Any open/connect failure folds to
       * a clean termination (the port closes; the renderer settles). The token
       * lives only inside the WorkspaceBackend's request — method/stream state only is
       * ever logged.
       */
      const producer = (
        streamId: string,
        port: MessagePortMain,
        body: unknown
      ): Effect.Effect<void> =>
        coreTransport.current.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                log.warn('ask stream opened with no live session — closing', { context: { streamId } }),
              onSome: client =>
                client.openAskStream(body).pipe(
                  Effect.flatMap(response =>
                    forward(response, port).pipe(
                      Effect.zipRight(
                        Effect.sync(() => {
                          port.postMessage(DONE);
                        })
                      )
                    )
                  ),
                  Effect.catchAll(error =>
                    log.warn('ask stream open failed — closing', { context: {
                      streamId,
                      reason: error.reason,
                    } })
                  )
                ),
            })
          )
        );

      const open: StreamBrokerApi['open'] = ({ streamId, sender, body }) =>
        Effect.gen(function* () {
          if (yield* FiberMap.has(fibers, streamId)) {
            return yield* Effect.fail(new StreamError({ code: 'DUPLICATE_STREAM', streamId }));
          }

          // Resume seam: the renderer re-sends full message parts on
          // approval. DefaultChatTransport drives approval-resume as a fresh POST
          // (a new stream), so the real producer does not block on this — the
          // sink stays wired as part of the port protocol.
          const resumes = yield* Queue.bounded<ResumeMessage>(4);
          const abortSignal = yield* Deferred.make<void>();

          const { port1, port2 } = new MessageChannelMain();
          // Callback edges: parse + enqueue only, no business logic.
          const onMessage = (event: Electron.MessageEvent) => {
            const parsed = parseInboundStreamMessage(event.data);
            if (!parsed.success) {
              unsafeLog.warn('invalid stream port message ignored', { context: {
                streamId,
                issues: parsed.issues,
              } });
              return;
            }
            if (parsed.data.type === 'abort') {
              Deferred.unsafeDone(abortSignal, Effect.void);
            } else {
              Queue.unsafeOffer(resumes, { parts: parsed.data.parts });
            }
          };
          const onClose = () => {
            Deferred.unsafeDone(abortSignal, Effect.void);
          };
          port1.on('message', onMessage);
          port1.on('close', onClose);
          port1.start();

          const cleanup = Effect.sync(() => {
            port1.removeListener('message', onMessage);
            port1.removeListener('close', onClose);
            port1.close();
          });

          // Abort (renderer message or port close) wins the race and interrupts
          // the producer (which cancels the reader → aborts the fetch); external
          // interruption (scope close) hits both branches.
          const supervised = Effect.race(
            producer(streamId, port1, body).pipe(Effect.as('completed' as const)),
            Deferred.await(abortSignal).pipe(Effect.as('aborted' as const))
          ).pipe(
            Effect.flatMap(outcome =>
              outcome === 'completed'
                ? Ref.update(completed, n => n + 1)
                : Ref.update(aborted, n => n + 1).pipe(
                    Effect.zipRight(log.info('stream aborted', { context: { streamId } }))
                  )
            ),
            Effect.ensuring(cleanup)
          );

          yield* Ref.update(opened, n => n + 1);
          yield* FiberMap.run(fibers, streamId, supervised);
          yield* Effect.sync(() => {
            sender.postMessage(streamPortChannel(streamId), null, [port2]);
          });
          yield* log.info('stream opened', { context: { streamId } });
        });

      const service: StreamBrokerApi = {
        open,
        stats: Effect.all({
          opened: Ref.get(opened),
          active: FiberMap.size(fibers),
          completed: Ref.get(completed),
          aborted: Ref.get(aborted),
        }),
      };
      return service;
    })
  );
