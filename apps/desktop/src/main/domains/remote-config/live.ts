import { Effect, Layer, Schedule, Stream, SubscriptionRef } from 'effect';
import { z } from 'zod';
import { updateRequirementSchema, type UpdateRequirement } from '@prismical/desktop-contracts';
import { AppConfig } from '../../infra/config/service';
import { OperationalDb } from '../../infra/operational-db/service';
import { MainLogger } from '../../infra/logging/service';
import { desktopFetch, withClientHeaders } from '../../infra/http/client';
import { AuthService } from '../auth/service';
import { DesktopI18n } from '../i18n/service';
import { TelemetryService } from '../telemetry/service';
import { RemoteConfig } from './service';

export const REMOTE_CONFIG_KEY = 'remote-config';
export const REMOTE_CONFIG_INTERVAL = '15 minutes';
// Prismical's public endpoint exposes only this domain. Ignore future envelope fields.
const envelopeSchema = z.object({ updateRequirement: updateRequirementSchema.optional() });

export const makeRemoteConfigLive = (fetchFn: typeof fetch = desktopFetch) =>
  Layer.scoped(
    RemoteConfig,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* OperationalDb;
      const auth = yield* AuthService;
      const telemetry = yield* TelemetryService;
      const { locale } = yield* DesktopI18n;
      const log = (yield* MainLogger).scoped('remote-config');
      const requirement = yield* SubscriptionRef.make<UpdateRequirement | null>(null);
      const activeRequirement = (value: UpdateRequirement | undefined) =>
        value?.required && value.evaluatedVersion === config.appVersion ? value : null;
      const cached = yield* db
        .getSetting(REMOTE_CONFIG_KEY)
        .pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (cached) {
        const parsed = yield* Effect.try(() => envelopeSchema.parse(JSON.parse(cached))).pipe(
          Effect.option
        );
        if (parsed._tag === 'Some')
          yield* SubscriptionRef.set(
            requirement,
            activeRequirement(parsed.value.updateRequirement)
          );
      }

      let generation = 0;
      const writeLock = yield* Effect.makeSemaphore(1);
      let fetchLock = yield* Effect.makeSemaphore(1);
      const request = Effect.gen(function* () {
        const startedGeneration = generation;
        const url = new URL('/apps/v1/remote-config', config.endpoints.coreApiUrl);
        url.searchParams.set('version', config.appVersion);
        url.searchParams.set('platform', config.platform);
        url.searchParams.set('locale', locale);
        const session = yield* SubscriptionRef.get(auth.sessionState);
        const token = session.activeSub ? yield* auth.getIdToken(session.activeSub) : null;
        const deviceId = yield* telemetry.getDeviceId;
        const headers = withClientHeaders(
          {
            'prismical-device-id': deviceId,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          { ...config, locale }
        );
        const envelope = yield* Effect.tryPromise({
          try: async signal => {
            const response = await fetchFn(url, { headers, signal });
            if (!response.ok) throw new Error(`Remote config HTTP ${response.status}`);
            return envelopeSchema.parse(await response.json());
          },
          catch: error => error,
        }).pipe(Effect.timeout('15 seconds'));
        yield* writeLock.withPermits(1)(
          Effect.gen(function* () {
            if (generation !== startedGeneration || !envelope.updateRequirement) return;
            // Missing policy, invalid responses and offline failures never lift a cached block.
            yield* SubscriptionRef.set(requirement, activeRequirement(envelope.updateRequirement));
            yield* db.setSetting(REMOTE_CONFIG_KEY, JSON.stringify(envelope));
          })
        );
      }).pipe(
        Effect.catchAll(error =>
          log.warn('Remote config refresh failed; retaining last policy', { error })
        )
      );
      const refresh = Effect.suspend(() =>
        fetchLock.withPermitsIfAvailable(1)(request).pipe(Effect.asVoid)
      );

      // Always refresh on startup, even with a warm cache, then at Amical's cadence.
      yield* Effect.forkScoped(refresh.pipe(Effect.repeat(Schedule.fixed(REMOTE_CONFIG_INTERVAL))));
      yield* Effect.forkScoped(
        Stream.runForEach(
          auth.sessionState.changes.pipe(
            Stream.map(state => state.activeSub ?? null),
            Stream.changes,
            Stream.drop(1)
          ),
          () =>
            Effect.gen(function* () {
              generation++;
              // Version policy survives sign-out. Coalesce requests within the new identity,
              // without letting an old identity's in-flight request delay this refresh.
              fetchLock = yield* Effect.makeSemaphore(1);
              yield* Effect.forkScoped(refresh);
            })
        )
      );
      return {
        requirement,
        isUpdateRequired: SubscriptionRef.get(requirement).pipe(
          Effect.map(value => value !== null)
        ),
        refresh,
      };
    })
  );

export const RemoteConfigLive = makeRemoteConfigLive();
