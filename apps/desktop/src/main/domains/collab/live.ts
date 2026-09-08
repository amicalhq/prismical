import { MessageChannelMain, type MessagePortMain } from 'electron';
import {
  collabPortChannel,
  parseInboundCollabMessage,
  type InboundCollabMessage,
  type OutboundCollabMessage,
} from '@prismical/desktop-contracts';
import { Deferred, Effect, FiberMap, Layer, Option, Queue } from 'effect';
import { MainLogger } from '../../infra/logging/service';
import type { ProductDbError } from '../../infra/product-db/service';
import { CollabBridge, type NoteBodyStoreApi } from './store';
import { CollabBroker, CollabError, type CollabBrokerApi } from './service';

/** One live port of a note's relay group (the main-side port1 handle). */
interface PortEntry {
  readonly openId: string;
  readonly port: MessagePortMain;
}

/**
 * How far one store dispatch got: 'stored' (durable), 'no-workspace' (the
 * workspace swapped under a live port — the port is on its way out anyway) or
 * 'failed' (the store REJECTED the write). Only the update lane distinguishes
 * them; see handleMessage.
 */
type StoreOutcome = 'stored' | 'no-workspace' | 'failed';

export const CollabBrokerLive: Layer.Layer<CollabBroker, never, MainLogger | CollabBridge> =
  Layer.scoped(
    CollabBroker,
    Effect.gen(function* () {
      const logger = yield* MainLogger;
      const log = logger.scoped('collab');
      const unsafeLog = logger.scopedSync('collab');
      const bridge = yield* CollabBridge;

      // Every pump fiber lands here; layer-scope close interrupts them all
      // (each fiber's ensuring closes its port — full cleanup on shutdown).
      const fibers = yield* FiberMap.make<string>();
      // Per-note relay registry. Mutated only inside Effects/cleanup on the
      // single JS thread; entries are removed by each open's own cleanup.
      const registry = new Map<string, Set<PortEntry>>();

      const post = (port: MessagePortMain, message: OutboundCollabMessage): void => {
        port.postMessage(message);
      };

      const open: CollabBrokerApi['open'] = ({ openId, noteId, sender }) =>
        Effect.gen(function* () {
          if (yield* FiberMap.has(fibers, openId)) {
            return yield* Effect.fail(new CollabError({ code: 'DUPLICATE', openId }));
          }
          // The store captured here serves the replay; per-message work
          // re-reads the bridge so a workspace swap degrades instead of
          // acting on a closed database.
          const storeAtOpen = Option.getOrNull(yield* bridge.current);
          if (storeAtOpen === null) {
            return yield* Effect.fail(new CollabError({ code: 'NO_WORKSPACE', openId }));
          }

          const inbox = yield* Queue.unbounded<InboundCollabMessage>();
          const closedSignal = yield* Deferred.make<void>();

          const { port1, port2 } = new MessageChannelMain();
          const entry: PortEntry = { openId, port: port1 };

          // Callback edges: parse + enqueue only, no business logic.
          const onMessage = (event: Electron.MessageEvent) => {
            const parsed = parseInboundCollabMessage(event.data);
            if (!parsed.success) {
              unsafeLog.warn('invalid collab port message ignored', { context: {
                openId,
                issues: parsed.issues,
              } });
              return;
            }
            Queue.unsafeOffer(inbox, parsed.data);
          };
          const onClose = () => {
            Deferred.unsafeDone(closedSignal, Effect.void);
          };
          port1.on('message', onMessage);
          port1.on('close', onClose);
          port1.start();

          const peers = registry.get(noteId) ?? new Set<PortEntry>();
          peers.add(entry);
          registry.set(noteId, peers);

          /** Relay a blob VERBATIM to every OTHER port of the same note (never echo). */
          const relay = (data: Uint8Array): void => {
            const group = registry.get(noteId);
            if (group === undefined) return;
            for (const peer of group) {
              if (peer !== entry) post(peer.port, { type: 'update', data });
            }
          };

          const withStore = (
            what: string,
            run: (store: NoteBodyStoreApi) => Effect.Effect<unknown, ProductDbError>
          ): Effect.Effect<StoreOutcome> =>
            bridge.current.pipe(
              Effect.flatMap(
                Option.match({
                  // Workspace swapped under a live port: drop + warn, never crash.
                  onNone: () =>
                    log
                      .warn(`collab ${what} dropped — no workspace`, { context: { openId } })
                      .pipe(Effect.as('no-workspace' as const)),
                  onSome: store =>
                    run(store).pipe(
                      Effect.as('stored' as const),
                      Effect.catchAll(error =>
                        log
                          .warn(`collab ${what} failed`, { context: { openId }, error: error.cause })
                          .pipe(Effect.as('failed' as const))
                      )
                    ),
                })
              )
            );

          const handleMessage = (message: InboundCollabMessage): Effect.Effect<void> => {
            switch (message.type) {
              case 'update':
                // Append FIRST (awaited — sequential per port), then relay the
                // blob verbatim so live windows converge even under a swap.
                //
                // A REJECTED append is the one case that must NOT relay: the
                // log (the only authority in local mode) now has a gap that
                // leaves every LATER update unapplicable on replay, so relaying
                // would spread an edit no store holds and desynchronize the
                // windows from the log. Tell the ORIGIN to resync instead — it
                // heals the gap with a full state snapshot.
                return withStore('update append', store =>
                  store.appendUpdate(noteId, message.data)
                ).pipe(
                  Effect.flatMap(outcome =>
                    Effect.sync(() => {
                      if (outcome === 'failed') post(port1, { type: 'resync' });
                      else relay(message.data);
                    })
                  )
                );
              case 'flush':
                return withStore('flush', store =>
                  store.applyFlush(noteId, {
                    text: message.text,
                    markdown: message.markdown,
                    firstLine: message.firstLine,
                  })
                ).pipe(Effect.asVoid);
              case 'compact':
                return withStore('compact', store =>
                  store.compact(noteId, message.upTo, message.state)
                ).pipe(Effect.asVoid);
            }
          };

          /**
           * The pump: replay the persisted log ({type:'update'} per blob, then
           * the hydrated marker), then consume inbound messages one at a time.
           * A replay read failure terminates the open (no hydrated marker —
           * the renderer stays on its degraded path) rather than hydrating an
           * empty doc a later flush would project over.
           */
          const producer: Effect.Effect<void> = storeAtOpen.listUpdates(noteId).pipe(
            Effect.flatMap(rows =>
              Effect.sync(() => {
                for (const row of rows) post(port1, { type: 'update', data: row.update });
                const seq = rows.length === 0 ? 0 : rows[rows.length - 1]!.seq;
                post(port1, { type: 'hydrated', seq, count: rows.length });
              }).pipe(
                Effect.zipRight(
                  Queue.take(inbox).pipe(Effect.flatMap(handleMessage), Effect.forever)
                )
              )
            ),
            Effect.catchAll(error =>
              log.error('collab log replay failed — closing', { context: { openId }, error: error.cause })
            )
          );

          const cleanup = Effect.sync(() => {
            port1.removeListener('message', onMessage);
            port1.removeListener('close', onClose);
            const group = registry.get(noteId);
            if (group !== undefined) {
              group.delete(entry);
              if (group.size === 0) registry.delete(noteId);
            }
            port1.close();
          });

          // Port close (renderer gone) wins the race and interrupts the pump;
          // external interruption (scope close) hits both branches.
          const supervised = Effect.race(
            producer.pipe(Effect.as('completed' as const)),
            Deferred.await(closedSignal).pipe(Effect.as('closed' as const))
          ).pipe(Effect.asVoid, Effect.ensuring(cleanup));

          yield* FiberMap.run(fibers, openId, supervised);
          yield* Effect.sync(() => {
            sender.postMessage(collabPortChannel(openId), null, [port2]);
          });
          yield* log.info('collab log opened', { context: { openId, noteId } });
        });

      const service: CollabBrokerApi = { open };
      return service;
    })
  );
