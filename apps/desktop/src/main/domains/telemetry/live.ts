/**
 * TelemetryServiceLive — the main-process posthog-node client
 * behind the TelemetryService tag. Electron-free and SDK-free (it depends only on
 * the injected PostHogSink factory + the PostHogSink type), so it unit-tests
 * against a fake sink with no network.
 *
 * Lifecycle: boot-scoped. On build it mints/reads the anonymous device id (a
 * persisted UUID in the OperationalDb KV — a DbError never blocks boot, an
 * ephemeral id is used instead), builds the super-property set, opens the sink,
 * and forks a subscriber that mirrors AuthService.sessionState into identify/reset
 * (the SAME (sub, org) reduction the session lifecycle uses). shutdown() flushes
 * the buffer on scope close (quit).
 *
 * Disabled when no analytics key/host is configured or under E2E ⇒ a no-op API,
 * no sink, no subscriber.
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { Effect, Layer, Ref, Stream } from 'effect';
import { AppModeService } from '../app-mode/service';
import type { AuthState } from '../auth/policy';
import { AuthService } from '../auth/service';
import { AppConfig } from '../../infra/config/service';
import { MainLogger } from '../../infra/logging/service';
import { OperationalDb } from '../../infra/operational-db/service';
import type { MakePostHogSink } from './posthog-sink';
import {
  DEVICE_ID_KEY,
  TelemetryService,
  type TelemetryIdentity,
  type TelemetryServiceApi,
} from './service';

/** The PostHog `platform` super-property: darwin→macos, win32→windows. */
const platformTag = (platform: NodeJS.Platform): string =>
  platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform;

/**
 * Active (sub, org) identity from an auth snapshot — mirrors
 * runtime/workspace-lifecycle's desiredSession, replicated here so the domain does
 * not import the runtime layer.
 */
const activeIdentity = (state: AuthState): TelemetryIdentity | null => {
  if (state.gate === 'signed-out' || state.activeSub === undefined) return null;
  const account = state.accounts[state.activeSub];
  if (account === undefined) return null;
  return {
    sub: account.sub,
    email: account.email,
    ...(account.name === undefined ? {} : { name: account.name }),
    ...(account.activeOrgId === undefined ? {} : { orgId: account.activeOrgId }),
  };
};

/** Same-identity key (sub+org) — display-claim refreshes (name/email) don't re-identify. */
const identityKey = (identity: TelemetryIdentity | null): string =>
  identity === null ? '' : `${identity.sub}\0${identity.orgId ?? ''}`;

const NOOP_API: TelemetryServiceApi = {
  capture: () => Effect.void,
  captureException: () => Effect.void,
  identify: () => Effect.void,
  reset: Effect.void,
};

export const makeTelemetryServiceLive = (
  makeSink: MakePostHogSink
): Layer.Layer<
  TelemetryService,
  never,
  AppConfig | OperationalDb | MainLogger | AuthService | AppModeService
> =>
  Layer.scoped(
    TelemetryService,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const store = yield* OperationalDb;
      const log = (yield* MainLogger).scoped('telemetry');
      const auth = yield* AuthService;
      const { mode, chosen } = yield* AppModeService;

      // Local mode sends nothing from main: local telemetry is off / opt-in,
      // and the renderer's posthog-js is opted out by default. It also NEVER
      // mirrors an auth identity — a local install must not be
      // joinable to a person. Nor does an UNCHOSEN fresh install (it resolves
      // 'cloud' only by default; the user may be about to pick local — nothing
      // beacons under a policy nobody picked). No sink is constructed at
      // all. A chosen cloud mode keeps service telemetry under the ToS.
      if (mode === 'local' || !chosen) {
        yield* log.info('telemetry disabled', { mode, chosen });
        return NOOP_API;
      }

      const apiKey = config.endpoints.analyticsKey;
      const host = config.endpoints.analyticsHost;
      // Dev (null key) and E2E stay silent: no client, no subscriber.
      if (apiKey === null || host === null || config.isE2E) {
        yield* log.info('telemetry disabled', {
          hasKey: apiKey !== null,
          hasHost: host !== null,
          isE2E: config.isE2E,
        });
        return NOOP_API;
      }

      // Anonymous device id — a persisted UUID (not node-machine-id: no reg.exe /
      // hardware fingerprint). A DbError must never block boot: fall back to an
      // ephemeral id (telemetry works, just not stable across restarts).
      const deviceId = yield* store.getSetting(DEVICE_ID_KEY).pipe(
        Effect.flatMap(existing =>
          existing !== null
            ? Effect.succeed(existing)
            : Effect.sync(() => randomUUID()).pipe(
                Effect.tap(id => store.setSetting(DEVICE_ID_KEY, id))
              )
        ),
        Effect.catchTag('DbError', error =>
          log
            .warn('device id read/write failed — using an ephemeral id', { op: error.op })
            .pipe(Effect.as(randomUUID()))
        )
      );

      const superProperties: Record<string, string | number | boolean> = {
        platform: platformTag(config.platform),
        app_version: config.appVersion,
        app_is_packaged: config.isPackaged,
        os_release: os.release(),
        arch: process.arch,
      };

      const sink = makeSink(apiKey, host);
      // The current distinct-id: the device id while anonymous, the user sub once
      // identified. Org (if any) rides every capture as a PostHog group.
      const current = yield* Ref.make<{ distinctId: string; orgId?: string }>({
        distinctId: deviceId,
      });

      const capture: TelemetryServiceApi['capture'] = (event, properties) =>
        Ref.get(current).pipe(
          Effect.flatMap(({ distinctId, orgId }) =>
            Effect.sync(() =>
              sink.capture({
                distinctId,
                event,
                properties: { ...superProperties, ...properties },
                ...(orgId === undefined ? {} : { groups: { organization: orgId } }),
              })
            )
          )
        );

      const captureException: TelemetryServiceApi['captureException'] = (error, properties) =>
        Ref.get(current).pipe(
          Effect.flatMap(({ distinctId }) =>
            Effect.sync(() =>
              sink.captureException(error, distinctId, { ...superProperties, ...properties })
            )
          )
        );

      const identify: TelemetryServiceApi['identify'] = identity =>
        Ref.set(current, {
          distinctId: identity.sub,
          ...(identity.orgId === undefined ? {} : { orgId: identity.orgId }),
        }).pipe(
          Effect.zipRight(
            Effect.sync(() => {
              sink.identify({
                distinctId: identity.sub,
                properties: {
                  ...superProperties,
                  ...(identity.email === undefined ? {} : { email: identity.email }),
                  ...(identity.name === undefined ? {} : { name: identity.name }),
                },
              });
              if (identity.orgId !== undefined) {
                sink.groupIdentify({ groupType: 'organization', groupKey: identity.orgId });
              }
            })
          )
        );

      // Back to the anonymous device id. deviceId is a STABLE anonymous DEVICE
      // identifier that is never merged into a user (no $anon_distinct_id is sent),
      // so returning to it on logout/switch cannot bleed one user's identity onto
      // the next on a shared device — the renderer's posthog-js keeps its own
      // rotating anon id and merges that on login (product-event attribution).
      const reset: TelemetryServiceApi['reset'] = Ref.set(current, { distinctId: deviceId });

      // Mirror auth identity into telemetry: identify on sign-in, reset on
      // sign-out, re-identify on account/org switch. `changes` replays the current
      // state first, so a restored session identifies at boot. Keyed on (sub, org)
      // only — a refreshed display claim never re-identifies.
      const lastKey = yield* Ref.make('');
      yield* Effect.forkScoped(
        Stream.runForEach(auth.sessionState.changes, state =>
          Effect.gen(function* () {
            const desired = activeIdentity(state);
            const key = identityKey(desired);
            if (key === (yield* Ref.get(lastKey))) return;
            yield* Ref.set(lastKey, key);
            yield* desired === null ? reset : identify(desired);
          })
        )
      );

      // Best-effort flush on quit (boot scope close). A rejected/timed-out flush
      // (offline) must not become a finalizer defect; 2s keeps headroom under the
      // runtime's 5s dispose deadline.
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => sink.shutdown(2_000).catch(() => undefined)).pipe(
          Effect.zipRight(log.info('telemetry client shut down'))
        )
      );

      yield* log.info('telemetry enabled', { platform: superProperties.platform });
      return { capture, captureException, identify, reset };
    })
  );
