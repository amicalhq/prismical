import { openAsBlob } from 'node:fs';
import { MessageChannelMain } from 'electron';
import {
  fileUploadPortChannel,
  parseInboundFileUploadMessage,
  type FileUploadPortMessage,
  type FileUploadResult,
} from '@prismical/desktop-contracts';
import { Clock, Deferred, Duration, Effect, FiberMap, Layer, Ref } from 'effect';
import { desktopFetch } from '../../infra/http/client';
import { MainLogger } from '../../infra/logging/service';
import { FileUploadBroker, FileUploadError, type FileUploadBrokerApi } from './service';

/** The same budget as the shared page upload; a longer transfer is interrupted. */
export const UPLOAD_TIMEOUT = Duration.minutes(30);
/** The page starts sending as soon as core answers, so an unused grant expires soon. */
export const GRANT_TTL = Duration.minutes(10);
/** Core allows one uploading import per org; keep only the newest few unused grants. */
export const MAX_GRANTS = 8;

export interface FileUploadDeps {
  readonly fetchFn: (url: string, init: RequestInit & { readonly duplex: 'half' }) => Promise<Response>;
  /** Opens the picked file from disk without reading it into memory. */
  readonly openFile: (path: string) => Promise<Blob>;
}

const CANCELLED: FileUploadResult = { ok: false, reason: 'cancelled' };
const INTERRUPTED: FileUploadResult = { ok: false, reason: 'interrupted' };
const REJECTED: FileUploadResult = { ok: false, reason: 'rejected' };

export const makeFileUploadBrokerLive = (
  deps: FileUploadDeps = { fetchFn: desktopFetch, openFile: path => openAsBlob(path) }
): Layer.Layer<FileUploadBroker, never, MainLogger> =>
  Layer.effect(
    FileUploadBroker,
    Effect.gen(function* () {
      const logger = yield* MainLogger;
      const log = logger.scoped('file-upload');
      const unsafeLog = logger.scopedSync('file-upload');
      // Layer-scope close interrupts every transfer (which aborts its fetch).
      const fibers = yield* FiberMap.make<string>();
      // Granted URL → expiry (epoch ms) and the import's core cancel, oldest first.
      interface Grant {
        readonly expiresAt: number;
        readonly abandon: Effect.Effect<void>;
      }
      const grants = yield* Ref.make<ReadonlyMap<string, Grant>>(new Map());

      const grant: FileUploadBrokerApi['grant'] = (url, abandon) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* Ref.update(grants, current => {
            const live = [...current].filter(([key, { expiresAt }]) => expiresAt > now && key !== url);
            return new Map([
              ...live.slice(-(MAX_GRANTS - 1)),
              [url, { expiresAt: now + Duration.toMillis(GRANT_TTL), abandon }],
            ]);
          });
        });

      /** Consume the URL's grant; undefined when it is missing or expired. */
      const takeGrant = (url: string): Effect.Effect<Grant | undefined> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          return yield* Ref.modify(grants, current => {
            const found = current.get(url);
            if (found === undefined) return [undefined, current] as const;
            const next = new Map(current);
            next.delete(url);
            return [found.expiresAt > now ? found : undefined, next] as const;
          });
        });

      /** Stream the file to the URL; every outcome is a result. */
      const send = (
        url: string,
        filePath: string,
        contentType: string,
        onProgress: (percent: number) => void
      ): Effect.Effect<FileUploadResult> =>
        Effect.tryPromise({ try: () => deps.openFile(filePath), catch: () => REJECTED }).pipe(
          Effect.flatMap(file =>
            Effect.tryPromise({
              try: async signal => {
                let sent = 0;
                let reported = -1;
                const body = file.stream().pipeThrough(
                  new TransformStream<Uint8Array, Uint8Array>({
                    transform(chunk, controller) {
                      sent += chunk.byteLength;
                      const percent = Math.floor((sent / file.size) * 100);
                      if (percent !== reported) {
                        reported = percent;
                        onProgress(percent);
                      }
                      controller.enqueue(chunk);
                    },
                  })
                );
                const response = await deps.fetchFn(url, {
                  method: 'PUT',
                  // An explicit length keeps the body out of chunked encoding.
                  headers: { 'Content-Type': contentType, 'Content-Length': String(file.size) },
                  body,
                  duplex: 'half',
                  // Storage answers the PUT itself; a redirect is never a success.
                  redirect: 'error',
                  signal,
                });
                await response.body?.cancel().catch(() => undefined);
                return response.ok ? ({ ok: true } as const) : REJECTED;
              },
              catch: () => INTERRUPTED,
            })
          ),
          Effect.timeoutOrElse({ duration: UPLOAD_TIMEOUT, orElse: () => Effect.fail(INTERRUPTED) }),
          Effect.catch(result => Effect.succeed(result))
        );

      const start: FileUploadBrokerApi['start'] = ({ uploadId, url, filePath, contentType, sender }) =>
        Effect.gen(function* () {
          if (yield* FiberMap.has(fibers, uploadId)) {
            return yield* Effect.fail(new FileUploadError({ code: 'DUPLICATE_UPLOAD' }));
          }
          const granted = yield* takeGrant(url);
          if (granted === undefined) {
            yield* log.warn('file upload refused: url not granted', { context: { uploadId } });
            return yield* Effect.fail(new FileUploadError({ code: 'NOT_GRANTED' }));
          }

          const stop = yield* Deferred.make<'cancel' | 'closed'>();
          const { port1, port2 } = new MessageChannelMain();
          const post = (message: FileUploadPortMessage): void => {
            try {
              port1.postMessage(message);
            } catch {
              // The port is already closed; nobody is listening.
            }
          };
          // Callback edges: parse and signal only.
          const onMessage = (event: Electron.MessageEvent) => {
            if (parseInboundFileUploadMessage(event.data).success) {
              Deferred.doneUnsafe(stop, Effect.succeed('cancel' as const));
            } else {
              unsafeLog.warn('invalid file upload port message ignored', { context: { uploadId } });
            }
          };
          const onClose = () => {
            Deferred.doneUnsafe(stop, Effect.succeed('closed' as const));
          };
          port1.on('message', onMessage);
          port1.on('close', onClose);
          port1.start();

          const cleanup = Effect.sync(() => {
            port1.removeListener('message', onMessage);
            port1.removeListener('close', onClose);
            port1.close();
          });

          // A cancel (message or port close) wins the race and interrupts the
          // send, which aborts the fetch. The page's own cancel handles core
          // after a message; after a close, main cancels the import itself.
          const supervised = Effect.yieldNow.pipe(
            // Register with FiberMap before a callback can close the owner.
            Effect.andThen(
              Effect.race(
                send(url, filePath, contentType, percent => post({ type: 'progress', percent })),
                Deferred.await(stop)
              )
            ),
            Effect.flatMap(outcome => {
              const result = typeof outcome === 'string' ? CANCELLED : outcome;
              post({ type: 'done', result });
              const closed = outcome === 'closed';
              return log
                .info('file upload finished', {
                  context: { uploadId, outcome: closed ? 'abandoned' : result.ok ? 'ok' : result.reason },
                })
                .pipe(Effect.andThen(closed ? granted.abandon : Effect.void));
            }),
            Effect.ensuring(cleanup)
          );

          // Hand over the port before the transfer starts, so an upload always has an owner.
          yield* Effect.sync(() => {
            sender.postMessage(fileUploadPortChannel(uploadId), null, [port2]);
          }).pipe(Effect.onError(() => cleanup));
          yield* FiberMap.run(fibers, uploadId, supervised);
          yield* log.info('file upload started', { context: { uploadId } });
        });

      const service: FileUploadBrokerApi = { grant, start };
      return service;
    })
  );

export const FileUploadBrokerLive = makeFileUploadBrokerLive();
