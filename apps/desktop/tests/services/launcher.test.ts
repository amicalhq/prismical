import { mkdtemp, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Effect, Layer, SubscriptionRef } from 'effect';
import { describe, expect, it } from 'vitest';
import { runLauncherServer, parseLauncherRequest } from '../../src/main/domains/launcher/server';
import { RecordingBridge, type RecordingBridgeApi } from '../../src/main/domains/recording/bridge';
import { idleRecordingState } from '../../src/main/domains/recording/service';
import { FloatBridge } from '../../src/main/domains/windows/float-bridge';
import { validateLauncherIntent } from '../../src/main/domains/launcher/intent';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';

function send(socketPath: string, command: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method: command === 'status' ? 'GET' : 'POST',
        path: '/' + command,
        headers: {
          'x-request-id': randomUUID(),
          'x-expires-at': String(Date.now() + 10000),
          ...headers,
        },
      },
      res => {
        let body = '';
        res.on('data', chunk => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(body) }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}
describe('launcher local IPC', () => {
  it('rejects browser origins, extra query parameters and unsupported actions', () => {
    for (const req of [
      { method: 'GET', url: '/start-recording', headers: {} },
      { method: 'POST', url: '/start-recording', headers: { origin: 'https://example.com' } },
      { method: 'POST', url: '/start-recording?note=1', headers: {} },
      { method: 'POST', url: '/open-floating-note', headers: {} },
      { method: 'GET', url: '/status', headers: { 'sec-fetch-site': 'cross-site' } },
    ])
      expect(parseLauncherRequest(req)).toBeNull();
  });
  it('keeps private permissions, deduplicates starts, rejects stale sessions, revokes Stop and failed opens', async () => {
    const dir = await mkdtemp('/tmp/prsm-launcher-');
    const socket = path.join(dir, 'launcher/raycast.sock');
    let starts = 0;
    let reveals = 0;
    let destroyWindow = () => {};
    const recordingState = Effect.runSync(SubscriptionRef.make(idleRecordingState));
    let stops = 0;
    let generation = 1;
    let ready = true;
    let openResult = true;
    const layer = Layer.mergeAll(
      testConfigLayer({ platform: 'darwin', userDataDir: dir }),
      makeTestLogger().layer,
      Layer.succeed(RecordingBridge, {
        stateChanges: SubscriptionRef.changes(recordingState),
        launcherContext: Effect.sync(() => ({ generation, ready })),
        stopActive: Effect.sync(() => {
          stops++;
          generation++;
        }),
      } as RecordingBridgeApi),
      Layer.effect(
        FloatBridge,
        Effect.gen(function* () {
          return {
            state: yield* SubscriptionRef.make<{ open: boolean; noteId: string | null }>({
              open: false,
              noteId: null,
            }),
            open: (_id, options) =>
              Effect.sync(() => {
                if (options?.fresh) starts++;
                else reveals++;
                options?.onWindow?.({
                  id: 401,
                  once: (_event, listener) => {
                    destroyWindow = listener;
                  },
                });
                return openResult;
              }),
            collapse: Effect.void,
            dockBack: Effect.void,
            reset: Effect.void,
          };
        })
      )
    );
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* runLauncherServer;
            yield* Effect.promise(async () => {
              expect((await stat(socket)).mode & 0o777).toBe(0o600);
              expect((await stat(path.dirname(socket))).mode & 0o777).toBe(0o700);
              const initial = (await send(socket, 'status')).body;
              expect(initial).toMatchObject({
                protocolVersion: 1,
                ready: true,
                capabilities: ['start-recording', 'stop-recording'],
              });
              const session = String(initial.session);
              const headers = { 'x-session': session, 'x-request-id': randomUUID() };
              expect(
                (
                  await send(socket, 'start-recording', {
                    ...headers,
                    origin: 'https://example.com',
                  })
                ).status
              ).toBe(400);
              expect(
                (await send(socket, 'start-recording', { ...headers, 'x-expires-at': '1' })).status
              ).toBe(400);
              expect(
                (
                  await send(socket, 'start-recording', {
                    ...headers,
                    'x-session': 'stale',
                    'x-request-id': randomUUID(),
                  })
                ).body.ok
              ).toBe(false);
              expect((await send(socket, 'start-recording', headers)).body.ok).toBe(true);
              expect((await send(socket, 'start-recording', headers)).body.ok).toBe(true);
              expect(
                (await send(socket, 'start-recording', { 'x-session': session })).body.message
              ).toContain('already requested');
              expect(starts).toBe(1);
              expect(reveals).toBe(1);
              expect(validateLauncherIntent(401, 1, headers['x-request-id'], null)).toBe(true);
              ready = false;
              expect((await send(socket, 'stop-recording', { 'x-session': session })).body.ok).toBe(
                true
              );
              expect(stops).toBe(1);
              expect(validateLauncherIntent(401, 1, headers['x-request-id'], null)).toBe(false);
              ready = true;
              openResult = false;
              const next = {
                'x-session': String((await send(socket, 'status')).body.session),
                'x-request-id': randomUUID(),
              };
              expect((await send(socket, 'start-recording', next)).body.ok).toBe(false);
              expect(validateLauncherIntent(401, generation, next['x-request-id'], null)).toBe(
                false
              );
              await Effect.runPromise(
                SubscriptionRef.set(recordingState, {
                  ...idleRecordingState,
                  status: 'recording',
                  noteId: 'active-note',
                  recordingId: 'active-recording',
                })
              );
              await expect
                .poll(async () => (await send(socket, 'status')).body.recordingStatus)
                .toBe('recording');
              const revealFailure = await send(socket, 'start-recording', {
                'x-session': String((await send(socket, 'status')).body.session),
              });
              expect(revealFailure.body).toMatchObject({
                ok: false,
                message: 'Recording is active. Open Prismical to view it.',
              });
              await Effect.runPromise(SubscriptionRef.set(recordingState, idleRecordingState));
              await expect
                .poll(async () => (await send(socket, 'status')).body.recordingStatus)
                .toBe('idle');
              openResult = true;
              const deadlineId = randomUUID();
              const currentSession = String((await send(socket, 'status')).body.session);
              expect(
                (
                  await send(socket, 'start-recording', {
                    'x-session': currentSession,
                    'x-request-id': deadlineId,
                    'x-expires-at': String(Date.now() + 100),
                  })
                ).body.ok
              ).toBe(true);
              expect(validateLauncherIntent(401, generation, deadlineId, null)).toBe(true);
              await new Promise(resolve => setTimeout(resolve, 150));
              expect(validateLauncherIntent(401, generation, deadlineId, null)).toBe(false);
              // A fresh request must be admitted after the accepted request expires.
              expect(
                (await send(socket, 'start-recording', { 'x-session': currentSession })).body
                  .message
              ).toBe('Recording requested. Check Prismical.');
              const beforeDestroy = starts;
              destroyWindow();
              expect(
                (await send(socket, 'start-recording', { 'x-session': currentSession })).body
                  .message
              ).toBe('Recording requested. Check Prismical.');
              expect(starts).toBe(beforeDestroy + 1);
              for (let n = 0; n < 130; n++)
                await send(socket, 'start-recording', { 'x-session': currentSession });
              expect(
                (await send(socket, 'start-recording', { 'x-session': currentSession })).status
              ).toBe(429);
              const stopId = randomUUID();
              expect(
                (
                  await send(socket, 'stop-recording', {
                    'x-session': currentSession,
                    'x-request-id': stopId,
                  })
                ).body.ok
              ).toBe(true);
              expect(stops).toBe(2);
              expect(
                (
                  await send(socket, 'stop-recording', {
                    'x-session': currentSession,
                    'x-request-id': stopId,
                  })
                ).body.ok
              ).toBe(false);
              expect(stops).toBe(2);
            });
          })
        ).pipe(Effect.provide(layer))
      );
      await expect(stat(socket)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
