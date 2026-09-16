import { Effect, Queue } from 'effect';
import type {
  RecordingSocket,
  RecordingSocketEvent,
} from '../../src/main/domains/transport/recording-socket';
import { fakeSegment } from './fake-recording';

export const fakeStreamSegment = (...args: Parameters<typeof fakeSegment>) => ({
  ...fakeSegment(...args),
  orgUserId: 'ou_stream',
  isFinal: true,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  deletedAt: null,
});

export const fakeStreamOrganization = (orgId: string, enabled: boolean) => ({
  orgId,
  orgUserId: 'ou_stream',
  name: 'Stream',
  slug: 'stream',
  role: 'owner',
  allowPublicSharing: false,
  features: { recordingWebSocket: enabled },
  memberCount: 1,
});

export const makeFakeRecordingStream = () => {
  const sockets: {
    events: Queue.Queue<RecordingSocketEvent>;
    closed: boolean;
    frames: Buffer[];
    commands: Record<string, unknown>[];
    bufferedBytes: number;
  }[] = [];
  const checkpoints = { mic: 0, system: 0 };
  const received = { mic: 0, system: 0 };
  let autoAck = true;
  let trackBufferedAmount = false;
  let ackOnFlush = false;
  let autoFinalize = true;
  let recordingLimitMs = 3_600_000;
  let gcsFlushIntervalMs = 5000;
  let status: 'open' | 'stopping' | 'completed' = 'open';
  const reply = (index: number, message: unknown) =>
    Queue.offerUnsafe(sockets[index]!.events, { type: 'message', data: JSON.stringify(message) });
  const openSocket = () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<RecordingSocketEvent>();
      const index = sockets.length;
      const socket = {
        events,
        closed: false,
        frames: [] as Buffer[],
        commands: [] as Record<string, unknown>[],
        bufferedBytes: 0,
      };
      sockets.push(socket);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          socket.closed = true;
        })
      );
      Queue.offerUnsafe(events, { type: 'open' });
      return {
        events,
        bufferedAmount: () => socket.bufferedBytes,
        send: data =>
          Effect.sync(() => {
            if (typeof data !== 'string') {
              const frame = Buffer.from(data);
              socket.frames.push(frame);
              if (trackBufferedAmount) socket.bufferedBytes += frame.length;
              received[frame[0] === 0 ? 'mic' : 'system'] =
                frame.readUInt32LE(1) + (frame.length - 5) / 2;
              if (autoAck) {
                checkpoints[frame[0] === 0 ? 'mic' : 'system'] =
                  frame.readUInt32LE(1) + (frame.length - 5) / 2;
                reply(index, { type: 'ack', checkpoints });
              }
              return;
            }
            const command = JSON.parse(data);
            socket.commands.push(command);
            if (command.type === 'start')
              reply(index, {
                type: 'ready',
                version: 1,
                status,
                sampleRate: 48_000,
                lanes: command.lanes,
                checkpoints,
                maxFrameBytes: 131072,
                gcsFlushIntervalMs,
                recordingLimitMs,
              });
            if (ackOnFlush && (command.type === 'flush' || command.type === 'stop')) {
              Object.assign(checkpoints, received);
              reply(index, { type: 'ack', checkpoints });
            }
            if (
              (command.type === 'stop' || (command.type === 'start' && status !== 'open')) &&
              autoFinalize
            ) {
              reply(index, {
                type: 'stopped',
                checkpoints,
                durationMs: Math.round(Math.max(checkpoints.mic, checkpoints.system) / 48),
              });
              reply(index, { type: 'finalized', status: 'done', results: [] });
            }
          }),
      } satisfies RecordingSocket;
    });
  return {
    sockets,
    checkpoints,
    set trackBufferedAmount(value: boolean) {
      trackBufferedAmount = value;
    },
    openSocket,
    reply,
    set autoAck(value: boolean) {
      autoAck = value;
    },
    set ackOnFlush(value: boolean) {
      ackOnFlush = value;
    },
    set recordingLimitMs(value: number) {
      recordingLimitMs = value;
    },
    set gcsFlushIntervalMs(value: number) {
      gcsFlushIntervalMs = value;
    },
    set autoFinalize(value: boolean) {
      autoFinalize = value;
    },
    set status(value: typeof status) {
      status = value;
    },
    disconnect: (index: number, code = 1006) =>
      Queue.offerUnsafe(sockets[index]!.events, { type: 'close', code }),
  };
};
