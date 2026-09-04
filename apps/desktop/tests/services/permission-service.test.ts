/**
 * PermissionService tests. Fully headless: the real
 * PermissionServiceLive over a FAKE SystemPermissions port (a mock of Electron's
 * systemPreferences getMediaAccessStatus / askForMediaAccess + process version)
 * and a fake AppConfig platform. NO real TCC prompt, NO real electron, NO device.
 *
 * Asserts the permission-service contract:
 *  - mic granted        → mode allowed, no OS prompt;
 *  - mic not-determined → prompts (askForMediaAccess); grant → allowed, deny → PermissionError;
 *  - mic denied/restricted → PermissionError, no prompt (OS won't re-ask);
 *  - version < 14.2 on darwin (or unsupported Linux) → dual/system DEGRADE to mic-only;
 *  - version ≥ 14.2 on darwin → dual/system stay un-degraded;
 *  - Windows WASAPI loopback → dual/system stay un-degraded;
 *  - system-only mode needs NO mic.
 */
import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit, Layer, Option, Cause } from 'effect';
import type { MeetingCaptureMode } from '@/types/meeting';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import { makeFakeSystemPermissions } from '../helpers/fake-recording';
import { PermissionServiceLive } from '../../src/main/domains/recording/permission/live';
import {
  PermissionError,
  PermissionService,
} from '../../src/main/domains/recording/permission/service';
import type { MediaAccessStatus } from '../../src/main/infra/system-permissions/service';

interface BuildOpts {
  readonly platform?: NodeJS.Platform;
  readonly micStatus?: MediaAccessStatus;
  readonly requestGrants?: boolean;
  readonly systemVersion?: string;
}

const build = ({ platform = 'darwin', ...permInit }: BuildOpts = {}) => {
  const fake = makeFakeSystemPermissions(permInit);
  const logger = makeTestLogger();
  const layer = PermissionServiceLive.pipe(
    Layer.provide(fake.layer),
    Layer.provide(testConfigLayer({ platform })),
    Layer.provide(logger.layer)
  );
  return { fake, logger, layer };
};

const permissionErrorOf = (exit: Exit.Exit<unknown, unknown>): PermissionError | undefined =>
  Exit.isFailure(exit)
    ? (Option.getOrUndefined(Cause.failureOption(exit.cause)) as PermissionError | undefined)
    : undefined;

describe('PermissionService — mic gate', () => {
  it.effect('granted mic → mode allowed, NO OS prompt', () => {
    const { fake, layer } = build({ micStatus: 'granted' });
    return Effect.gen(function* () {
      const perm = yield* PermissionService;
      assert.strictEqual(yield* perm.micStatus, 'granted');
      const res = yield* perm.effectiveCaptureMode('mic');
      assert.strictEqual(res.mode, 'mic');
      assert.strictEqual(res.requested, 'mic');
      assert.isFalse(res.degraded);
      assert.strictEqual(fake.requestCalls(), 0, 'granted status must not trigger a prompt');
    }).pipe(Effect.provide(layer));
  });

  it.effect('not-determined mic → prompts, user grants → allowed', () => {
    const { fake, layer } = build({ micStatus: 'not-determined', requestGrants: true });
    return Effect.gen(function* () {
      const perm = yield* PermissionService;
      assert.strictEqual(yield* perm.requestMic, 'granted');
      assert.strictEqual(fake.requestCalls(), 1, 'not-determined triggers the OS prompt');
      const res = yield* perm.effectiveCaptureMode('mic');
      assert.strictEqual(res.mode, 'mic');
      assert.strictEqual(fake.requestCalls(), 2, 'the gate prompts again on start');
    }).pipe(Effect.provide(layer));
  });

  it.effect('not-determined mic → prompts, user denies → PermissionError, no spawn', () => {
    const { fake, layer } = build({ micStatus: 'not-determined', requestGrants: false });
    return Effect.gen(function* () {
      const perm = yield* PermissionService;
      const exit = yield* Effect.exit(perm.effectiveCaptureMode('mic'));
      assert.isTrue(Exit.isFailure(exit));
      const error = permissionErrorOf(exit);
      assert.instanceOf(error, PermissionError);
      assert.strictEqual(error!.reason, 'mic-denied');
      assert.strictEqual(error!.micStatus, 'denied');
      assert.strictEqual(error!.effective, 'mic');
      assert.strictEqual(fake.requestCalls(), 1, 'prompted once');
    }).pipe(Effect.provide(layer));
  });

  it.effect('already-denied mic → PermissionError WITHOUT re-prompting', () => {
    const { fake, layer } = build({ micStatus: 'denied' });
    return Effect.gen(function* () {
      const perm = yield* PermissionService;
      const exit = yield* Effect.exit(perm.effectiveCaptureMode('mic'));
      const error = permissionErrorOf(exit);
      assert.instanceOf(error, PermissionError);
      assert.strictEqual(error!.micStatus, 'denied');
      assert.strictEqual(fake.requestCalls(), 0, 'the OS never re-asks once denied');
    }).pipe(Effect.provide(layer));
  });

  it.effect('restricted mic → PermissionError (MDM-blocked, no prompt)', () => {
    const { fake, layer } = build({ micStatus: 'restricted' });
    return Effect.gen(function* () {
      const perm = yield* PermissionService;
      const exit = yield* Effect.exit(perm.effectiveCaptureMode('mic'));
      const error = permissionErrorOf(exit);
      assert.instanceOf(error, PermissionError);
      assert.strictEqual(error!.micStatus, 'restricted');
      assert.strictEqual(fake.requestCalls(), 0);
    }).pipe(Effect.provide(layer));
  });
});

describe('PermissionService — system-audio gate and degradation', () => {
  it.effect('darwin ≥ 14.2 → system audio available; dual/system stay un-degraded', () => {
    const { layer } = build({ systemVersion: '14.2.1' });
    return Effect.gen(function* () {
      const perm = yield* PermissionService;
      assert.isTrue(yield* perm.systemAudioAvailable);
      const dual = yield* perm.effectiveCaptureMode('dual');
      assert.strictEqual(dual.mode, 'dual');
      assert.isFalse(dual.degraded);
      const system = yield* perm.effectiveCaptureMode('system');
      assert.strictEqual(system.mode, 'system');
      assert.isFalse(system.degraded);
    }).pipe(Effect.provide(layer));
  });

  it.effect('darwin < 14.2 → system audio unavailable; dual DEGRADES to mic-only', () => {
    const { layer } = build({ systemVersion: '14.1.0', micStatus: 'granted' });
    return Effect.gen(function* () {
      const perm = yield* PermissionService;
      assert.isFalse(yield* perm.systemAudioAvailable);
      const res = yield* perm.effectiveCaptureMode('dual');
      assert.strictEqual(res.requested, 'dual');
      assert.strictEqual(res.mode, 'mic', 'dual degrades to mic below 14.2');
      assert.isTrue(res.degraded);
      assert.isFalse(res.systemAudioAvailable);
    }).pipe(Effect.provide(layer));
  });

  it.effect('darwin < 14.2 → system DEGRADES to mic-only', () => {
    const { layer } = build({ systemVersion: '13.5.0', micStatus: 'granted' });
    return Effect.gen(function* () {
      const perm = yield* PermissionService;
      const res = yield* perm.effectiveCaptureMode('system');
      assert.strictEqual(res.mode, 'mic');
      assert.isTrue(res.degraded);
    }).pipe(Effect.provide(layer));
  });

  it.effect('Windows WASAPI loopback → system audio available; dual/system stay un-degraded', () => {
    const { layer } = build({ platform: 'win32', systemVersion: '99.0', micStatus: 'granted' });
    return Effect.gen(function* () {
      const perm = yield* PermissionService;
      assert.isTrue(yield* perm.systemAudioAvailable);
      const dual = yield* perm.effectiveCaptureMode('dual');
      assert.strictEqual(dual.mode, 'dual');
      assert.isFalse(dual.degraded);
      const system = yield* perm.effectiveCaptureMode('system');
      assert.strictEqual(system.mode, 'system');
      assert.isFalse(system.degraded);
    }).pipe(Effect.provide(layer));
  });

  it.effect('unsupported Linux host → system audio unavailable; dual degrades', () => {
    const { layer } = build({ platform: 'linux', systemVersion: '99.0', micStatus: 'granted' });
    return Effect.gen(function* () {
      const perm = yield* PermissionService;
      assert.isFalse(yield* perm.systemAudioAvailable);
      const res = yield* perm.effectiveCaptureMode('dual');
      assert.strictEqual(res.mode, 'mic');
      assert.isTrue(res.degraded);
    }).pipe(Effect.provide(layer));
  });

  it.effect('degrade dual → mic still requires the mic (mic denied → PermissionError)', () => {
    const { layer } = build({ systemVersion: '14.0.0', micStatus: 'denied' });
    return Effect.gen(function* () {
      const perm = yield* PermissionService;
      const exit = yield* Effect.exit(perm.effectiveCaptureMode('dual'));
      const error = permissionErrorOf(exit);
      assert.instanceOf(error, PermissionError);
      assert.strictEqual(error!.requested, 'dual');
      assert.strictEqual(error!.effective, 'mic', 'degraded target is mic, and mic is denied');
    }).pipe(Effect.provide(layer));
  });

  it.effect('system-only capture needs NO mic (mic denied but system available → system)', () => {
    const { fake, layer } = build({ systemVersion: '14.4.0', micStatus: 'denied' });
    return Effect.gen(function* () {
      const perm = yield* PermissionService;
      const res = yield* perm.effectiveCaptureMode('system');
      assert.strictEqual(res.mode, 'system', 'system mode taps output only — mic grant irrelevant');
      assert.isFalse(res.degraded);
      assert.strictEqual(fake.requestCalls(), 0, 'no mic prompt for system-only capture');
    }).pipe(Effect.provide(layer));
  });
});

const modes: readonly MeetingCaptureMode[] = ['mic', 'system', 'dual'];

describe('PermissionService — fully-capable host passthrough', () => {
  it.effect('granted mic + ≥14.2 → every requested mode passes through unchanged', () => {
    const { layer } = build({ micStatus: 'granted', systemVersion: '14.6.0' });
    return Effect.gen(function* () {
      const perm = yield* PermissionService;
      for (const requested of modes) {
        const res = yield* perm.effectiveCaptureMode(requested);
        assert.strictEqual(res.mode, requested);
        assert.isFalse(res.degraded);
      }
    }).pipe(Effect.provide(layer));
  });
});
