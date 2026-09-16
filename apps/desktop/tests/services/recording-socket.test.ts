import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit, Result, Scope } from 'effect';
import { makeOpenRecordingSocket } from '../../src/main/domains/transport/recording-socket';
import { StaleSessionError } from '../../src/main/runtime/workspace-layer';

describe('main recording socket', () => {
  it.effect(
    'uses fresh guarded credentials for each WSS connection and closes with the scope',
    () =>
      Effect.gen(function* () {
        let version = 0;
        const calls: { url: string; protocols: string[]; closed: boolean }[] = [];
        const connect = makeOpenRecordingSocket(
          {
            coreApiUrl: 'https://core.test',
            resolveIdentity: Effect.sync(() => ({
              idToken: `token-${++version}`,
              activeOrgId: 'org_one',
            })),
          },
          (url, protocols) => {
            const call = { url, protocols, closed: false };
            calls.push(call);
            return {
              addEventListener: () => {},
              close: () => {
                call.closed = true;
              },
            } as unknown as WebSocket;
          }
        );
        for (let i = 0; i < 2; i++) {
          const scope = yield* Scope.make();
          yield* connect('rec_1').pipe(Scope.provide(scope));
          assert.isFalse(calls[i]!.closed);
          yield* Scope.close(scope, Exit.void);
          assert.isTrue(calls[i]!.closed);
          assert.strictEqual(calls[i]!.url, 'wss://core.test/apps/v1/me/recordings/rec_1/stream');
          assert.deepStrictEqual(calls[i]!.protocols, [
            'prismical-recording-v1',
            `bearer.token-${i + 1}`,
            'org.org_one',
          ]);
        }
      })
  );

  it.effect('a stale workspace cannot open a socket', () =>
    Effect.gen(function* () {
      let opened = false;
      const connect = makeOpenRecordingSocket(
        {
          coreApiUrl: 'https://core.test',
          resolveIdentity: Effect.fail(
            new StaleSessionError({ pinnedSub: 'old', reason: 'org-switched' })
          ),
        },
        () => {
          opened = true;
          throw new Error('must not connect');
        }
      );
      const result = yield* Effect.result(Effect.scoped(connect('rec_1')));
      assert.isTrue(Result.isFailure(result));
      assert.isFalse(opened);
    })
  );
});
