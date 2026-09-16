import { Data, Effect, Queue } from 'effect';
import type { CloudBackendDeps } from './live';

export const RECORDING_STREAM_PROTOCOL = 'prismical-recording-v1';

export class RecordingStreamError extends Data.TaggedError('RecordingStreamError')<{
  readonly code: string;
  readonly retryable: boolean;
}> {}

export type RecordingSocketEvent =
  | { readonly type: 'open' }
  | { readonly type: 'message'; readonly data: unknown }
  | { readonly type: 'close'; readonly code: number };

export interface RecordingSocket {
  readonly events: Queue.Queue<RecordingSocketEvent>;
  readonly send: (
    data: string | Uint8Array<ArrayBuffer>
  ) => Effect.Effect<void, RecordingStreamError>;
  readonly bufferedAmount: () => number;
}

/** Node's socket uses the main process trust store. Credentials never cross IPC. */
export const makeOpenRecordingSocket =
  (
    deps: Pick<CloudBackendDeps, 'coreApiUrl' | 'resolveIdentity'>,
    createSocket = (url: string, protocols: string[]) => new WebSocket(url, protocols)
  ) =>
  (recordingId: string) =>
    Effect.gen(function* () {
      const identity = yield* deps.resolveIdentity.pipe(
        Effect.mapError(() => new RecordingStreamError({ code: 'identity', retryable: true }))
      );
      const events = yield* Effect.acquireRelease(
        Queue.unbounded<RecordingSocketEvent>(),
        Queue.shutdown
      );
      const socket = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const url = new URL(
              `/apps/v1/me/recordings/${encodeURIComponent(recordingId)}/stream`,
              deps.coreApiUrl
            );
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            const protocols = [RECORDING_STREAM_PROTOCOL, `bearer.${identity.idToken}`];
            if (identity.activeOrgId) protocols.push(`org.${identity.activeOrgId}`);
            const socket = createSocket(url.toString(), protocols);
            socket.addEventListener('open', () => Queue.offerUnsafe(events, { type: 'open' }));
            socket.addEventListener('message', event =>
              Queue.offerUnsafe(events, { type: 'message', data: event.data })
            );
            socket.addEventListener('close', event =>
              Queue.offerUnsafe(events, { type: 'close', code: event.code })
            );
            socket.addEventListener('error', () =>
              Queue.offerUnsafe(events, { type: 'close', code: 1006 })
            );
            return socket;
          },
          catch: () => new RecordingStreamError({ code: 'connect', retryable: true }),
        }),
        socket => Effect.sync(() => socket.close())
      );
      return {
        events,
        bufferedAmount: () => socket.bufferedAmount,
        send: data =>
          Effect.try({
            try: () => socket.send(data),
            catch: () => new RecordingStreamError({ code: 'send', retryable: true }),
          }),
      } satisfies RecordingSocket;
    });
