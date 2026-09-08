/**
 * FloatBridge tests — the locked slot semantics against a
 * fake WindowRegistry:
 *   open(id)     opens the window at the note + sets the slot;
 *   open(null)   reuses the slot; retargets a live window via nav push;
 *   collapse     closes the window, KEEPS the slot;
 *   dockBack     closes, navs main to the note, focuses main, CLEARS the slot;
 *   an external close (onClosed) flips `open` without touching the slot.
 */
import { assert, describe, it } from '@effect/vitest';
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Scope, SubscriptionRef } from 'effect';
import { CHANNELS, type TransportResponse } from '@prismical/desktop-contracts';
import { makeTestLogger } from '../helpers/test-layers';
import { AppModeService, makeAppMode, type AppMode } from '../../src/main/domains/app-mode/service';
import { FloatBridge, FloatBridgeLive } from '../../src/main/domains/windows/float-bridge';
import { WindowRegistry, type WindowRegistryService } from '../../src/main/domains/windows/service';
import { RecordingBridge, type RecordingBridgeApi } from '../../src/main/domains/recording/bridge';
import { AuthService, type AuthApi } from '../../src/main/domains/auth/service';
import {
  WorkspaceTransport,
  type WorkspaceTransportApi,
} from '../../src/main/domains/transport/service';
import { initialAuthState, type AuthState } from '../../src/main/domains/auth/policy';

interface FakeRegistry {
  readonly service: WindowRegistryService;
  readonly openCalls: Array<{ noteId: string | null; search?: string }>;
  readonly floatSends: Array<{ channel: string; payload: unknown }>;
  readonly mainSends: Array<{ channel: string; payload: unknown }>;
  readonly focusMainCount: () => number;
  readonly closeCount: () => number;
  readonly hideCount: () => number;
  /** Simulate an OS-initiated close of the live float window. */
  readonly externalClose: () => void;
}

const makeFakeRegistry = (): FakeRegistry => {
  const openCalls: Array<{ noteId: string | null; search?: string }> = [];
  const floatSends: Array<{ channel: string; payload: unknown }> = [];
  const mainSends: Array<{ channel: string; payload: unknown }> = [];
  let focusMain = 0;
  let closes = 0;
  let hides = 0;
  let liveOnClosed: (() => void) | null = null;

  const service = {
    openFloatNoteWindow: (options: {
      noteId: string | null;
      search?: string;
      onClosed: () => void;
    }) =>
      Effect.sync(() => {
        openCalls.push({ noteId: options.noteId, search: options.search });
        liveOnClosed = options.onClosed;
      }),
    closeFloatNoteWindow: Effect.sync(() => {
      closes += 1;
      const onClosed = liveOnClosed;
      liveOnClosed = null;
      onClosed?.();
    }),
    // Hide keeps the window (and its onClosed registration) alive.
    hideFloatNoteWindow: Effect.sync(() => {
      hides += 1;
    }),
    sendToFloatNoteWindow: (channel: string, payload: unknown) =>
      Effect.sync(() => {
        // Mirror the real registry: no live window (never opened, or
        // destroyed — HIDDEN still counts as live) ⇒ the send is dropped.
        if (liveOnClosed === null) return false;
        floatSends.push({ channel, payload });
        return true;
      }),
    sendToMainWindow: (channel: string, payload: unknown) =>
      Effect.sync(() => {
        mainSends.push({ channel, payload });
        return true;
      }),
    focusMainWindow: Effect.sync(() => {
      focusMain += 1;
    }),
    floatNoteWindow: Effect.succeed(Option.none()),
  } as unknown as WindowRegistryService;

  return {
    service,
    openCalls,
    floatSends,
    mainSends,
    focusMainCount: () => focusMain,
    closeCount: () => closes,
    hideCount: () => hides,
    externalClose: () => {
      const onClosed = liveOnClosed;
      liveOnClosed = null;
      onClosed?.();
    },
  };
};

// The open guard only reads accounts/activeSub (never the gate) — an entry
// under the active sub means "signed in" to the bridge.
const signedInAuthState: AuthState = {
  ...initialAuthState,
  accounts: { sub_1: { sub: 'sub_1', email: 'user@example.com', orgs: [] } },
  activeSub: 'sub_1',
};

const setup = (
  activeNoteId: string | null = null,
  authState: AuthState = signedInAuthState,
  appMode: AppMode = 'cloud',
  response: TransportResponse | Effect.Effect<TransportResponse> = {
    ok: true, status: 200, bodyJson: { results: [] },
  }
) =>
  Effect.gen(function* () {
    const logger = makeTestLogger();
    const fake = makeFakeRegistry();
    const scope = yield* Scope.make();
    // Only activeNoteId is consulted by the bridge — the rest is unreachable.
    const recordingStub = {
      activeNoteId: Effect.succeed(activeNoteId),
    } as unknown as RecordingBridgeApi;
    // Only sessionState is consulted (the signed-out open guard).
    const authStub = {
      sessionState: yield* SubscriptionRef.make<AuthState>(authState),
    } as unknown as AuthApi;
    const requests: unknown[] = [];
    const transport = {
      request: (request: unknown) =>
        Effect.gen(function* () {
          requests.push(request);
          return Effect.isEffect(response) ? yield* response : response;
        }),
    } as unknown as WorkspaceTransportApi;
    const layer = FloatBridgeLive.pipe(
      Layer.provide(Layer.succeed(WorkspaceTransport, transport)),
      Layer.provide(Layer.succeed(WindowRegistry, fake.service)),
      Layer.provide(Layer.succeed(RecordingBridge, recordingStub)),
      Layer.provide(Layer.succeed(AuthService, authStub)),
      Layer.provide(Layer.effect(AppModeService, makeAppMode(appMode, true))),
      Layer.provide(logger.layer)
    );
    const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
    const bridge = Context.get(ctx, FloatBridge);
    return { bridge, fake, scope, logger, requests, auth: authStub };
  }).pipe(Effect.orDie);

describe('FloatBridge slot semantics', () => {
  it.effect('open(id) opens the window at the note and sets the slot', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.bridge.open('nt_1');
      assert.deepStrictEqual(h.fake.openCalls, [{ noteId: 'nt_1', search: '' }]);
      assert.deepStrictEqual(yield* SubscriptionRef.get(h.bridge.state), {
        open: true,
        noteId: 'nt_1',
      });
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('collapse keeps the slot; open(null) reopens it', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.bridge.open('nt_1');
      yield* h.bridge.collapse;
      // Keep-alive: collapse HIDES (the renderer stays warm) — never destroys.
      assert.strictEqual(h.fake.hideCount(), 1);
      assert.strictEqual(h.fake.closeCount(), 0);
      assert.deepStrictEqual(yield* SubscriptionRef.get(h.bridge.state), {
        open: false,
        noteId: 'nt_1', // the slot SURVIVES a collapse (never lossy)
      });

      yield* h.bridge.open(null);
      assert.deepStrictEqual(h.fake.openCalls.at(-1), { noteId: 'nt_1', search: '' });
      assert.deepStrictEqual(yield* SubscriptionRef.get(h.bridge.state), {
        open: true,
        noteId: 'nt_1',
      });
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('open on a LIVE window with a different note retargets via nav push', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.bridge.open('nt_1');
      yield* h.bridge.open('nt_2');
      assert.deepStrictEqual(h.fake.floatSends, [
        { channel: CHANNELS.navPush, payload: { path: '/float/nt_2' } },
      ]);
      assert.deepStrictEqual(yield* SubscriptionRef.get(h.bridge.state), {
        open: true,
        noteId: 'nt_2',
      });
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('dockBack closes, navs main to the note, focuses main, CLEARS the slot', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.bridge.open('nt_1');
      yield* h.bridge.dockBack;
      assert.strictEqual(h.fake.closeCount(), 1);
      assert.deepStrictEqual(h.fake.mainSends, [
        { channel: CHANNELS.navPush, payload: { path: '/notes/nt_1' } },
      ]);
      assert.strictEqual(h.fake.focusMainCount(), 1);
      assert.deepStrictEqual(yield* SubscriptionRef.get(h.bridge.state), {
        open: false,
        noteId: null, // the note went home — the slot is CLEARED
      });
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('an external close flips open without touching the slot', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.bridge.open('nt_1');
      h.fake.externalClose();
      assert.deepStrictEqual(yield* SubscriptionRef.get(h.bridge.state), {
        open: false,
        noteId: 'nt_1',
      });
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('dockBack with an empty slot just closes + focuses main (no nav)', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.bridge.dockBack;
      assert.deepStrictEqual(h.fake.mainSends, []);
      assert.strictEqual(h.fake.focusMainCount(), 1);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect("open(null) with an empty slot resolves the LIVE recording's note (main-side)", () =>
    Effect.gen(function* () {
      const h = yield* setup('nt_live');
      yield* h.bridge.open(null);
      assert.deepStrictEqual(h.fake.openCalls, [{ noteId: 'nt_live', search: '' }]);
      assert.deepStrictEqual(yield* SubscriptionRef.get(h.bridge.state), {
        open: true,
        noteId: 'nt_live',
      });
      // An explicit slot still wins over the recording.
      yield* h.bridge.open('nt_other');
      assert.deepStrictEqual(yield* SubscriptionRef.get(h.bridge.state), {
        open: true,
        noteId: 'nt_other',
      });
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('reset (sign-out) closes the window AND clears the slot', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.bridge.open('nt_1');
      yield* h.bridge.reset;
      assert.strictEqual(h.fake.closeCount(), 1);
      assert.deepStrictEqual(yield* SubscriptionRef.get(h.bridge.state), {
        open: false,
        noteId: null, // the departing account's note never leaks into the next session
      });
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('open fresh+autoStart bypasses the slot and the live recording', () =>
    Effect.gen(function* () {
      // A live recording's note AND a slot both exist — a dock-initiated start
      // must ignore both and open a slot-less float carrying the intent params.
      const h = yield* setup('nt_live');
      yield* h.bridge.open('nt_slot');
      yield* h.bridge.collapse;
      yield* h.bridge.open(null, { fresh: true, autoStart: true });
      assert.deepStrictEqual(h.fake.openCalls.at(-1), {
        noteId: null,
        search: '?fresh=1&autostart=1',
      });
      // The slot clears transiently — the float view reports the created note
      // back through open(id), restoring it.
      assert.deepStrictEqual(yield* SubscriptionRef.get(h.bridge.state), {
        open: true,
        noteId: null,
      });
      yield* h.bridge.open('nt_created');
      assert.deepStrictEqual(yield* SubscriptionRef.get(h.bridge.state), {
        open: true,
        noteId: 'nt_created',
      });
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('open fresh on a LIVE window retargets to the slot-less fresh route', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.bridge.open('nt_1');
      yield* h.bridge.open(null, { fresh: true, autoStart: true });
      assert.deepStrictEqual(h.fake.floatSends.at(-1), {
        channel: CHANNELS.navPush,
        payload: { path: '/float?fresh=1&autostart=1' },
      });
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('open with NO active account is refused (invisible-window guard)', () =>
    Effect.gen(function* () {
      const h = yield* setup(null, initialAuthState); // signed out
      const opened = yield* h.bridge.open(null, { fresh: true, autoStart: true });
      assert.strictEqual(opened, false);
      assert.deepStrictEqual(h.fake.openCalls, []);
      assert.deepStrictEqual(yield* SubscriptionRef.get(h.bridge.state), {
        open: false,
        noteId: null,
      });
      assert.isDefined(h.logger.find(e => e.message === 'float open ignored — no active account'));
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('local mode opens with no active account because the guard is cloud-only', () =>
    Effect.gen(function* () {
      // Local mode is accountless by design and renders the float
      // unconditionally — the invisible-window rationale does not apply.
      const h = yield* setup(null, initialAuthState, 'local');
      const opened = yield* h.bridge.open('nt_1');
      assert.strictEqual(opened, true);
      assert.deepStrictEqual(h.fake.openCalls, [{ noteId: 'nt_1', search: '' }]);
      assert.deepStrictEqual(yield* SubscriptionRef.get(h.bridge.state), {
        open: true,
        noteId: 'nt_1',
      });
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('open on a LIVE window with the SAME note but autoStart still retargets with the intent', () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.bridge.open('nt_1');
      yield* h.bridge.open('nt_1', { autoStart: true });
      assert.deepStrictEqual(h.fake.floatSends.at(-1), {
        channel: CHANNELS.navPush,
        payload: { path: '/float/nt_1?autostart=1' },
      });
      yield* Scope.close(h.scope, Exit.void);
    })
  );
});

const organization = (orgId: string, floatingMode?: boolean) => ({
  orgId,
  orgUserId: `member_${orgId}`,
  name: 'Test',
  slug: orgId,
  role: 'owner',
  allowPublicSharing: false,
  features: {},
  memberCount: 1,
  ...(floatingMode === undefined
    ? {}
    : {
        entitlements: {
          planExternalId: null,
          aiModelTier: 'standard',
          pooled: false,
          features: {
            askAi: true,
            floatingMode,
            byok: true,
            automations: true,
            extendedRecording: true,
          },
          limits: {
            seats: null,
            cloudTranscriptionSeconds: null,
            aiCredits: null,
            maxRecordingSeconds: null,
          },
        },
      }),
});
const orgAuthState: AuthState = {
  ...signedInAuthState,
  accounts: { sub_1: { ...signedInAuthState.accounts.sub_1!, activeOrgId: 'org_1' } },
};

describe('FloatBridge plan gate', () => {
  it.effect('blocks the active org even when another org allows floating mode', () =>
    Effect.gen(function* () {
      const h = yield* setup(null, orgAuthState, 'cloud', {
        ok: true,
        status: 200,
        bodyJson: { results: [organization('org_2', true), organization('org_1', false)] },
      });
      assert.strictEqual(yield* h.bridge.open(null, { fresh: true, autoStart: true }), false);
      assert.deepStrictEqual(h.fake.openCalls, []);
      assert.deepStrictEqual(h.fake.floatSends, []);
      assert.deepStrictEqual(yield* SubscriptionRef.get(h.bridge.state), {
        open: false,
        noteId: null,
      });
      assert.deepStrictEqual(h.fake.mainSends, [
        {
          channel: CHANNELS.navPush,
          payload: { path: '/settings/billing', notice: 'floating-mode-unavailable' },
        },
      ]);
      assert.strictEqual(h.fake.focusMainCount(), 1);
      assert.deepStrictEqual(h.requests, [{ method: 'GET', path: '/apps/v1/me/organizations' }]);
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  for (const floatingMode of [true, undefined]) {
    it.effect(`allows an org with floatingMode=${floatingMode}`, () =>
      Effect.gen(function* () {
        const h = yield* setup(null, orgAuthState, 'cloud', {
          ok: true,
          status: 200,
          bodyJson: { results: [organization('org_1', floatingMode)] },
        });
        assert.strictEqual(yield* h.bridge.open('nt_1'), true);
        assert.strictEqual(h.fake.openCalls.length, 1);
        assert.deepStrictEqual(h.fake.mainSends, []);
        yield* Scope.close(h.scope, Exit.void);
      })
    );
  }

  for (const response of [
    { error: { code: 'INTERNAL' as const } },
    { ok: true as const, status: 500, bodyJson: {} },
    { ok: true as const, status: 200, bodyJson: {} },
    { ok: true as const, status: 200, bodyJson: { results: [organization('org_2', true)] } },
  ]) {
    it.effect(
      `does not open when the active plan cannot be read: ${JSON.stringify(response)}`,
      () =>
        Effect.gen(function* () {
          const h = yield* setup(null, orgAuthState, 'cloud', response);
          assert.strictEqual(yield* h.bridge.open(null), false);
          assert.deepStrictEqual(h.fake.openCalls, []);
          assert.deepStrictEqual(h.fake.mainSends, []);
          yield* Scope.close(h.scope, Exit.void);
        })
    );
  }

  it.effect('retargets an already-open window without a second plan request', () =>
    Effect.gen(function* () {
      const h = yield* setup(null, orgAuthState, 'cloud', {
        ok: true,
        status: 200,
        bodyJson: { results: [organization('org_1', true)] },
      });
      assert.strictEqual(yield* h.bridge.open(null, { fresh: true }), true);
      assert.strictEqual(yield* h.bridge.open('nt_created'), true);
      assert.strictEqual(h.requests.length, 1);
      assert.deepStrictEqual(h.fake.floatSends.at(-1), {
        channel: CHANNELS.navPush,
        payload: { path: '/float/nt_created' },
      });
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  it.effect('rechecks the plan when reopening after a downgrade', () =>
    Effect.gen(function* () {
      const row = organization('org_1', true);
      const h = yield* setup(null, orgAuthState, 'cloud', {
        ok: true,
        status: 200,
        bodyJson: { results: [row] },
      });
      assert.strictEqual(yield* h.bridge.open('nt_1'), true);
      yield* h.bridge.collapse;
      row.entitlements!.features.floatingMode = false;
      assert.strictEqual(yield* h.bridge.open('nt_2'), false);
      assert.strictEqual(h.fake.openCalls.length, 1);
      assert.deepStrictEqual(yield* SubscriptionRef.get(h.bridge.state), {
        open: false,
        noteId: 'nt_1',
      });
      yield* Scope.close(h.scope, Exit.void);
    })
  );

  for (const nextState of [
    initialAuthState,
    {
      ...orgAuthState,
      accounts: { sub_1: { ...orgAuthState.accounts.sub_1!, activeOrgId: 'org_2' } },
    },
  ]) {
    it.effect(
      `ignores a response after ${nextState.activeSub ? 'switching orgs' : 'sign-out'}`,
      () =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const result = yield* Deferred.make<TransportResponse>();
          const h = yield* setup(
            null,
            orgAuthState,
            'cloud',
            Deferred.succeed(started, undefined).pipe(Effect.zipRight(Deferred.await(result)))
          );
          const opening = yield* Effect.fork(h.bridge.open(null));
          yield* Deferred.await(started);
          yield* SubscriptionRef.set(h.auth.sessionState, nextState);
          yield* Deferred.succeed(result, {
            ok: true,
            status: 200,
            bodyJson: { results: [organization('org_1', true)] },
          });
          assert.strictEqual(yield* Fiber.join(opening), false);
          assert.deepStrictEqual(h.fake.openCalls, []);
          assert.deepStrictEqual(h.fake.mainSends, []);
          yield* Scope.close(h.scope, Exit.void);
        })
    );
  }

  it.effect('local mode never requests cloud entitlements', () =>
    Effect.gen(function* () {
      const h = yield* setup(null, orgAuthState, 'local', { error: { code: 'INTERNAL' } });
      assert.strictEqual(yield* h.bridge.open(null), true);
      assert.deepStrictEqual(h.requests, []);
      yield* Scope.close(h.scope, Exit.void);
    })
  );
});
