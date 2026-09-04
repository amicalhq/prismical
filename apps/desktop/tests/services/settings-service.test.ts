/**
 * SettingsService domain tests — the device-settings ref
 * over a fake OperationalDb (electron-free): boot seeding, defensive per-field
 * decode, merge/clamp/persist on set, and the observable change stream.
 */
import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Scope, Stream } from 'effect';
import { DEFAULT_DEVICE_SETTINGS, type DeviceSettings } from '@prismical/desktop-contracts';
import { makeFakeOperationalDb } from '../helpers/fake-operational-db';
import { makeTestLogger } from '../helpers/test-layers';
import { SettingsService } from '../../src/main/domains/settings/service';
import { SettingsServiceLive } from '../../src/main/domains/settings/live';

const build = (seed: Record<string, string> = {}) => {
  const logger = makeTestLogger();
  const db = makeFakeOperationalDb(seed);
  const layer = SettingsServiceLive.pipe(Layer.provide(db.layer), Layer.provide(logger.layer));
  return { logger, db, layer };
};

/** Cooperative wait for the forked change collector (no clock involved). */
const drainUntil = (predicate: () => boolean) =>
  Effect.iterate(0, {
    while: n => n < 200 && !predicate(),
    body: n => Effect.yieldNow().pipe(Effect.as(n + 1)),
  });

describe('SettingsService', () => {
  it.effect('boot seeds defaults from an empty DB', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const settings = Context.get(ctx, SettingsService);
      assert.deepStrictEqual(yield* settings.get, DEFAULT_DEVICE_SETTINGS);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a stored pref:* row round-trips through get; unset fields keep defaults', () =>
    Effect.gen(function* () {
      const { layer } = build({
        'pref:widgetVisibility': JSON.stringify('never'),
        'pref:widgetNormalizedY': JSON.stringify(0.25),
        'pref:launchAtLogin': JSON.stringify(true),
        'pref:language': JSON.stringify('de'),
      });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const settings = Context.get(ctx, SettingsService);
      const current = yield* settings.get;
      assert.strictEqual(current.widgetVisibility, 'never');
      assert.strictEqual(current.widgetNormalizedY, 0.25);
      assert.strictEqual(current.launchAtLogin, true);
      assert.strictEqual(current.language, 'de');
      // Fields with no stored row keep their defaults.
      assert.strictEqual(current.dockVisible, DEFAULT_DEVICE_SETTINGS.dockVisible);
      assert.strictEqual(current.updateChannel, DEFAULT_DEVICE_SETTINGS.updateChannel);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect(
    'set merges, persists each CHANGED field JSON-encoded, updates the ref, clamps widgetNormalizedY',
    () =>
      Effect.gen(function* () {
        const { layer, db } = build();
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        const settings = Context.get(ctx, SettingsService);

        yield* settings.set({ dockVisible: false, widgetNormalizedY: 1.7, updateChannel: 'beta' });
        const current = yield* settings.get;
        assert.strictEqual(current.dockVisible, false);
        assert.strictEqual(current.widgetNormalizedY, 1); // clamped to the [0,1] ceiling
        assert.strictEqual(current.updateChannel, 'beta');
        // One JSON-encoded KV row per changed field, under the `pref:` prefix.
        assert.strictEqual(db.store.get('pref:dockVisible'), 'false');
        assert.strictEqual(db.store.get('pref:widgetNormalizedY'), '1');
        assert.strictEqual(db.store.get('pref:updateChannel'), '"beta"');
        // Untouched fields are not written.
        assert.isFalse(db.store.has('pref:language'));
        assert.isFalse(db.store.has('pref:launchAtLogin'));

        // The low end clamps too.
        yield* settings.set({ widgetNormalizedY: -0.5 });
        assert.strictEqual((yield* settings.get).widgetNormalizedY, 0);
        assert.strictEqual(db.store.get('pref:widgetNormalizedY'), '0');
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect(
    'set ignores an invalid enum field (leaves the current value) and does not persist it',
    () =>
      Effect.gen(function* () {
        const { layer, db } = build();
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        const settings = Context.get(ctx, SettingsService);

        // widgetVisibility is bogus (only reachable via a direct call — the IPC
        // schema would reject it first); it is dropped, dockVisible still applies.
        yield* settings.set({
          widgetVisibility: 'sometimes' as DeviceSettings['widgetVisibility'],
          dockVisible: false,
        });
        const current = yield* settings.get;
        assert.strictEqual(current.widgetVisibility, DEFAULT_DEVICE_SETTINGS.widgetVisibility);
        assert.strictEqual(current.dockVisible, false);
        assert.isFalse(db.store.has('pref:widgetVisibility'));
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect('a malformed stored value falls back to its default without throwing (per-field)', () =>
    Effect.gen(function* () {
      const { layer } = build({
        'pref:widgetVisibility': '"not-a-mode"', // valid JSON, bad enum
        'pref:updateChannel': 'not json at all', // unparseable
        'pref:widgetNormalizedY': '"0.3"', // wrong type (a JSON string, not a number)
        'pref:language': '"fr"', // valid JSON, unsupported interface locale
        'pref:dockVisible': JSON.stringify(false), // a good value survives alongside
      });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const settings = Context.get(ctx, SettingsService);
      const current = yield* settings.get;
      assert.strictEqual(current.widgetVisibility, DEFAULT_DEVICE_SETTINGS.widgetVisibility);
      assert.strictEqual(current.updateChannel, DEFAULT_DEVICE_SETTINGS.updateChannel);
      assert.strictEqual(current.language, DEFAULT_DEVICE_SETTINGS.language);
      assert.strictEqual(current.widgetNormalizedY, DEFAULT_DEVICE_SETTINGS.widgetNormalizedY);
      assert.strictEqual(current.dockVisible, false); // the one good field decoded
      yield* Scope.close(scope, Exit.void);
    })
  );

  // --- Dock settings ---------------------------------------------------------

  it.effect('dock fields decode from stored rows; unset dock fields keep defaults', () =>
    Effect.gen(function* () {
      const { layer } = build({
        'pref:dockAnchors': JSON.stringify({ '1': { nx: 0.5, ny: 0.25 } }),
        'pref:dockDisplayId': JSON.stringify('1'),
        'pref:floatNoteBounds': JSON.stringify({ '1': { nx: 0, ny: 0, nw: 0.3, nh: 0.6 } }),
        'pref:meetingNotifications': JSON.stringify(false),
        'pref:dockHotkey': JSON.stringify(''),
      });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const settings = Context.get(ctx, SettingsService);
      const current = yield* settings.get;
      assert.deepStrictEqual(current.dockAnchors, { '1': { nx: 0.5, ny: 0.25 } });
      assert.strictEqual(current.dockDisplayId, '1');
      assert.deepStrictEqual(current.floatNoteBounds, { '1': { nx: 0, ny: 0, nw: 0.3, nh: 0.6 } });
      assert.strictEqual(current.meetingNotifications, false);
      assert.strictEqual(current.dockHotkey, ''); // '' = hotkey disabled
      // Unset dock fields keep their defaults.
      assert.strictEqual(current.autoExpandOnRecording, false);
      assert.strictEqual(current.dockContentProtection, false);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('malformed dock rows fall back whole-field (bad anchors never block boot)', () =>
    Effect.gen(function* () {
      const { layer } = build({
        'pref:dockAnchors': JSON.stringify({ '1': { nx: 'oops', ny: 0.5 } }), // bad value type
        'pref:dockDisplayId': JSON.stringify(42), // wrong type (number)
        'pref:floatNoteBounds': JSON.stringify({ '1': { nx: 0.1 } }), // missing parts
        'pref:meetingNotifications': JSON.stringify('yes'), // wrong type
        'pref:dockHotkey': JSON.stringify(7), // wrong type
      });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const settings = Context.get(ctx, SettingsService);
      const current = yield* settings.get;
      assert.deepStrictEqual(current.dockAnchors, {});
      assert.strictEqual(current.dockDisplayId, null);
      assert.deepStrictEqual(current.floatNoteBounds, {});
      assert.strictEqual(current.meetingNotifications, true);
      assert.strictEqual(current.dockHotkey, DEFAULT_DEVICE_SETTINGS.dockHotkey);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('set persists dock fields (records JSON-encoded whole) and drops invalid ones', () =>
    Effect.gen(function* () {
      const { layer, db } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const settings = Context.get(ctx, SettingsService);

      yield* settings.set({
        dockAnchors: { '2': { nx: 1, ny: 0 } },
        dockDisplayId: '2',
        meetingNotifications: false,
        dockContentProtection: true,
      });
      const current = yield* settings.get;
      assert.deepStrictEqual(current.dockAnchors, { '2': { nx: 1, ny: 0 } });
      assert.strictEqual(current.dockDisplayId, '2');
      assert.strictEqual(current.meetingNotifications, false);
      assert.strictEqual(current.dockContentProtection, true);
      assert.strictEqual(db.store.get('pref:dockAnchors'), '{"2":{"nx":1,"ny":0}}');
      assert.strictEqual(db.store.get('pref:dockDisplayId'), '"2"');

      // An invalid record patch is dropped whole (a valid sibling still applies);
      // dockDisplayId accepts an explicit null (back to "primary").
      yield* settings.set({
        dockAnchors: { '2': { nx: Number.NaN, ny: 0 } } as DeviceSettings['dockAnchors'],
        dockDisplayId: null,
      });
      const after = yield* settings.get;
      assert.deepStrictEqual(after.dockAnchors, { '2': { nx: 1, ny: 0 } }); // unchanged
      assert.strictEqual(after.dockDisplayId, null);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect(
    'a value-identical record set does not rewrite the row (compared by value, not ref)',
    () =>
      Effect.gen(function* () {
        const { layer, db } = build();
        const scope = yield* Scope.make();
        const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
        const settings = Context.get(ctx, SettingsService);

        yield* settings.set({ dockAnchors: { '1': { nx: 0.5, ny: 0.5 } } });
        db.store.delete('pref:dockAnchors'); // sentinel: a rewrite would recreate it
        // A zero-movement dragEnd re-sets the SAME anchor as a fresh object.
        yield* settings.set({ dockAnchors: { '1': { nx: 0.5, ny: 0.5 } } });
        assert.isFalse(db.store.has('pref:dockAnchors'));
        yield* Scope.close(scope, Exit.void);
      })
  );

  it.effect('a DbError on the boot read logs and falls back to defaults (never blocks boot)', () =>
    Effect.gen(function* () {
      const { layer, logger, db } = build();
      db.failGet(true);
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const settings = Context.get(ctx, SettingsService);
      assert.deepStrictEqual(yield* settings.get, DEFAULT_DEVICE_SETTINGS);
      assert.isDefined(
        logger.find(e => e.message === 'settings read failed at boot — using defaults')
      );
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('reset deletes every pref row and publishes the defaults', () =>
    Effect.gen(function* () {
      const { layer, db } = build({
        'pref:launchAtLogin': JSON.stringify(true),
        'pref:dockVisible': JSON.stringify(false),
        'pref:widgetVisibility': JSON.stringify('never'),
      });
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const settings = Context.get(ctx, SettingsService);
      // The seeded values are live before the reset.
      assert.strictEqual((yield* settings.get).launchAtLogin, true);

      yield* settings.reset;

      // Every pref row is gone and the observed settings are the defaults again.
      assert.isFalse([...db.store.keys()].some(key => key.startsWith('pref:')));
      assert.deepStrictEqual(yield* settings.get, DEFAULT_DEVICE_SETTINGS);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('settings.changes replays the current value then emits each set', () =>
    Effect.gen(function* () {
      const { layer } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const settings = Context.get(ctx, SettingsService);

      const seen: DeviceSettings[] = [];
      yield* Stream.runForEach(settings.settings.changes, s =>
        Effect.sync(() => {
          seen.push(s);
        })
      ).pipe(Effect.fork);

      // The current value is replayed to the subscriber immediately.
      yield* drainUntil(() => seen.length >= 1);
      assert.strictEqual(seen.at(-1)?.widgetVisibility, 'always');

      yield* settings.set({ widgetVisibility: 'never' });
      yield* drainUntil(() => seen.some(s => s.widgetVisibility === 'never'));
      assert.strictEqual(seen.at(-1)?.widgetVisibility, 'never');
      yield* Scope.close(scope, Exit.void);
    })
  );
});

describe('SettingsService — transcription engine field', () => {
  const LOCAL = { engine: 'local', modelId: 'whisper-tiny', byokBaseUrl: null, byokModel: null } as const;

  it.effect('a stored pref:transcription record round-trips; a malformed one falls back to the default', () =>
    Effect.gen(function* () {
      const good = build({ 'pref:transcription': JSON.stringify(LOCAL) });
      const scope = yield* Scope.make();
      const goodCtx = yield* Layer.build(good.layer).pipe(Scope.extend(scope));
      assert.deepStrictEqual((yield* Context.get(goodCtx, SettingsService).get).transcription, LOCAL);

      const bad = build({ 'pref:transcription': JSON.stringify({ engine: 'turbo', modelId: null }) });
      const badCtx = yield* Layer.build(bad.layer).pipe(Scope.extend(scope));
      assert.deepStrictEqual(
        (yield* Context.get(badCtx, SettingsService).get).transcription,
        DEFAULT_DEVICE_SETTINGS.transcription
      );
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('set persists a valid record whole, drops an invalid one, and reset restores the default', () =>
    Effect.gen(function* () {
      const { layer, db } = build();
      const scope = yield* Scope.make();
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const settings = Context.get(ctx, SettingsService);

      const byok = { engine: 'byok', modelId: null, byokBaseUrl: 'https://byok.test/v1', byokModel: 'whisper-1' } as const;
      yield* settings.set({ transcription: byok });
      assert.deepStrictEqual((yield* settings.get).transcription, byok);
      assert.strictEqual(db.store.get('pref:transcription'), JSON.stringify(byok));

      // An invalid record (bad enum) is dropped whole — the current value stays.
      yield* settings.set({
        transcription: { ...byok, engine: 'nope' } as unknown as DeviceSettings['transcription'],
      });
      assert.deepStrictEqual((yield* settings.get).transcription, byok);

      yield* settings.reset;
      assert.deepStrictEqual((yield* settings.get).transcription, DEFAULT_DEVICE_SETTINGS.transcription);
      assert.isFalse(db.store.has('pref:transcription'));
      yield* Scope.close(scope, Exit.void);
    })
  );
});
