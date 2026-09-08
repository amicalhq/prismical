import { makeSuppressionCounter } from './suppression-counter';
import os from 'node:os';
import { Deferred, Effect, Layer, Stream, SubscriptionRef } from 'effect';
import { AppModeService } from '../app-mode/service';
import { AuthService } from '../auth/service';
import { SettingsService } from '../settings/service';
import { AppConfig } from '../../infra/config/service';
import { MainLogger } from '../../infra/logging/service';
import { OperationalDb } from '../../infra/operational-db/service';
import { sanitizeTelemetryProperties } from '../../../shared/telemetry-payload';
import { projectTelemetryException } from '../../../shared/telemetry-exception';
import { readMachineId, resolveDeviceId } from './device-id';
import { makeExceptionLimiter } from './exception-limiter';
import { telemetryIdentity, telemetryPolicy } from './policy';
import type { MakePostHogSink, PostHogSink } from './posthog-sink';
import { TelemetryService, type TelemetryServiceApi, type TelemetrySource } from './service';

export const makeTelemetryServiceLive = (
  makeSink: MakePostHogSink,
  machineId: () => Promise<string> = readMachineId
) =>
  Layer.scoped(
    TelemetryService,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* OperationalDb;
      const auth = yield* AuthService;
      const settings = yield* SettingsService;
      const { mode, chosenState } = yield* AppModeService;
      const logger = yield* MainLogger;
      const log = logger.scoped('telemetry');
      const { analyticsKey: key, analyticsHost: host } = config.endpoints;
      const configured = !config.isE2E && Boolean(key && host);
      let deviceId: string | undefined;
      const common = {
        app: 'prismical',
        ...(typeof __PRISMICAL_BUILD_ID__ === 'string' && __PRISMICAL_BUILD_ID__
          ? { build_id: __PRISMICAL_BUILD_ID__ }
          : {}),
        schema_version: 1,
        app_run_id: logger.appRunId,
        app_version: config.appVersion,
        app_is_packaged: config.isPackaged,
        platform:
          config.platform === 'darwin'
            ? 'macos'
            : config.platform === 'win32'
              ? 'windows'
              : config.platform,
        os_release: os.release(),
        arch: process.arch,
      };
      const identityKey = (identity: ReturnType<typeof telemetryIdentity>) =>
        JSON.stringify([identity?.sub ?? null, identity?.activeOrgId ?? null]);
      const snapshot = Effect.gen(function* () {
        const identity = telemetryIdentity(yield* SubscriptionRef.get(auth.sessionState), mode);
        const preference = !(yield* settings.get).telemetryOptOut;
        const chosen = yield* SubscriptionRef.get(chosenState);
        const policy = telemetryPolicy(configured && chosen, identity !== null, preference);
        return {
          policy,
          chosen,
          distinctId: identity?.sub ?? deviceId ?? '',
          orgId: identity?.activeOrgId,
          identityKey: identityKey(identity),
          key: JSON.stringify([policy.enabled, identity?.sub ?? deviceId, identity?.activeOrgId]),
        };
      });
      const initial = yield* snapshot;
      let revision = 0;
      let revisionIdentity = initial.identityKey;
      let revisionPreference = initial.policy.preference;
      let revisionChosen = initial.chosen;
      const noteBoundary = (identity: string, preference: boolean, chosen: boolean) => {
        if (
          identity !== revisionIdentity ||
          preference !== revisionPreference ||
          chosen !== revisionChosen
        ) {
          revision++;
          revisionIdentity = identity;
          revisionPreference = preference;
          revisionChosen = chosen;
        }
      };
      const state = yield* SubscriptionRef.make({ ...initial.policy, revision });
      const lock = yield* Effect.makeSemaphore(1);
      let active:
        | {
            key: string;
            identityKey: string;
            preference: boolean;
            chosen: boolean;
            sink: PostHogSink;
          }
        | undefined;
      let closed = false;
      const exceptions = makeExceptionLimiter();
      const captured = new WeakSet<object>();
      const recordExceptionDrop = yield* makeSuppressionCounter(
        logger.scopedSync('telemetry'),
        'Telemetry exception reports suppressed'
      );
      const recordQueueDrop = yield* makeSuppressionCounter(
        logger.scopedSync('telemetry'),
        'Telemetry events dropped at queue capacity'
      );
      const bestEffort = <A>(operation: Effect.Effect<A>) =>
        operation.pipe(
          Effect.catchAllCause(() => log.warn('telemetry operation failed').pipe(Effect.asVoid))
        );
      const invalidate = Effect.gen(function* () {
        exceptions.clear();
        const sink = active?.sink;
        active = undefined;
        if (sink) yield* bestEffort(Effect.sync(() => sink.discard()));
      });

      // Capture re-reads auth/settings, so an event cannot race a subscription push.
      const reconcile = Effect.gen(function* () {
        let next = yield* snapshot;
        if (!closed && next.policy.enabled && deviceId === undefined) {
          // Choosing the default cloud mode does not restart the app. Resolve
          // identity only when its live choice/consent first enables telemetry.
          deviceId = yield* resolveDeviceId(machineId).pipe(
            Effect.provideService(OperationalDb, db),
            Effect.provideService(MainLogger, logger)
          );
          next = yield* snapshot;
        }
        noteBoundary(next.identityKey, next.policy.preference, next.chosen);
        const nextState = { ...next.policy, revision };
        const previous = yield* SubscriptionRef.get(state);
        if (
          Object.keys(nextState).some(
            key =>
              nextState[key as keyof typeof nextState] !== previous[key as keyof typeof previous]
          )
        )
          yield* SubscriptionRef.set(state, nextState);
        if (active?.key !== next.key) {
          yield* invalidate;
          if (!closed && next.policy.enabled && key && host) {
            yield* bestEffort(
              Effect.sync(() => {
                // Queued SDK work may outlive this session. Recheck at transport time.
                const sink = makeSink(
                  key,
                  host,
                  () => !closed && Effect.runSync(snapshot).key === next.key,
                  recordQueueDrop
                );
                active = {
                  key: next.key,
                  identityKey: next.identityKey,
                  preference: next.policy.preference,
                  chosen: next.chosen,
                  sink,
                };
                if (next.policy.signedIn)
                  sink.identify({ distinctId: next.distinctId, properties: common });
              })
            );
          }
        }
        return next;
      });
      const getState = lock.withPermits(1)(
        reconcile.pipe(Effect.zipRight(SubscriptionRef.get(state)))
      );
      const send = (
        source: TelemetrySource,
        expectedRevision: number | undefined,
        operation: (
          sink: PostHogSink,
          current: Effect.Effect.Success<typeof snapshot>,
          context: Record<string, unknown>
        ) => void
      ) =>
        lock.withPermits(1)(
          bestEffort(
            Effect.gen(function* () {
              const current = yield* reconcile;
              if (closed || !current.policy.enabled || !active) return;
              if (
                (source === 'renderer' || expectedRevision !== undefined) &&
                expectedRevision !== revision
              )
                return;
              const sink = active.sink;
              yield* Effect.sync(() =>
                operation(sink, current, {
                  ...common,
                  runtime: source,
                  $process_person_profile: current.policy.signedIn,
                })
              );
            })
          )
        );
      const capture: TelemetryServiceApi['capture'] = (
        event,
        properties,
        source = 'main',
        expectedRevision
      ) =>
        send(source, expectedRevision, (sink, current, context) => {
          if (!/^[a-z][a-z0-9_]{0,99}$/.test(event)) return;
          sink.capture({
            distinctId: current.distinctId,
            event,
            properties: { ...sanitizeTelemetryProperties(properties), ...context },
            ...(current.orgId ? { groups: { organization: current.orgId } } : {}),
          });
        });
      const captureException: TelemetryServiceApi['captureException'] = (
        error,
        properties,
        source = 'main',
        expectedRevision
      ) =>
        send(source, expectedRevision, (sink, current, context) => {
          if (error !== null && typeof error === 'object') {
            if (captured.has(error)) return;
            captured.add(error);
          }
          const safeError = projectTelemetryException(error, source);
          const safeProperties = sanitizeTelemetryProperties(properties);
          if (
            !exceptions.admit(
              safeError,
              `${source}:${safeProperties.source ?? ''}:${safeProperties.error_context ?? ''}`
            )
          ) {
            recordExceptionDrop();
            return;
          }
          sink.captureException(safeError, current.distinctId, {
            ...safeProperties,
            ...sanitizeTelemetryProperties({
              error_code: Reflect.get(safeError, 'code'),
              reason: Reflect.get(safeError, 'reason'),
            }),
            ...context,
            ...(current.orgId ? { $groups: { organization: current.orgId } } : {}),
          });
        });
      let observedIdentity = identityKey(
        telemetryIdentity(yield* SubscriptionRef.get(auth.sessionState), mode)
      );
      let observedPreference = !(yield* settings.get).telemetryOptOut;
      let observedChosen = yield* SubscriptionRef.get(chosenState);
      const ready = {
        identity: yield* Deferred.make<void>(),
        preference: yield* Deferred.make<void>(),
        choice: yield* Deferred.make<void>(),
      };
      yield* Effect.forkScoped(
        Stream.runForEach(
          Stream.mergeWithTag(
            {
              identity: Stream.map(auth.sessionState.changes, value =>
                identityKey(telemetryIdentity(value, mode))
              ),
              preference: Stream.map(settings.settings.changes, value => !value.telemetryOptOut),
              choice: chosenState.changes,
            },
            { concurrency: 'unbounded' }
          ),
          change =>
            lock.withPermits(1)(
              Effect.gen(function* () {
                // Consume each emitted transition, not just the current snapshot:
                // A→B→A or ON→OFF→ON must revoke the earlier queue. If capture has
                // already opened the next session, do not discard that new queue.
                if (change._tag === 'identity') {
                  if (change.value !== observedIdentity)
                    noteBoundary(change.value, revisionPreference, revisionChosen);
                  if (change.value !== observedIdentity && active?.identityKey === observedIdentity)
                    yield* invalidate;
                  observedIdentity = change.value;
                } else if (change._tag === 'preference') {
                  if (change.value !== observedPreference)
                    noteBoundary(revisionIdentity, change.value, revisionChosen);
                  if (
                    change.value !== observedPreference &&
                    active?.preference === observedPreference
                  )
                    yield* invalidate;
                  observedPreference = change.value;
                } else {
                  if (change.value !== observedChosen)
                    noteBoundary(revisionIdentity, revisionPreference, change.value);
                  if (change.value !== observedChosen && active?.chosen === observedChosen)
                    yield* invalidate;
                  observedChosen = change.value;
                }
                yield* reconcile;
                yield* Deferred.succeed(ready[change._tag], undefined);
              })
            )
        )
      );
      // Do not expose capture until all lossless subscriptions are attached.
      yield* Deferred.await(ready.identity);
      yield* Deferred.await(ready.preference);
      yield* Deferred.await(ready.choice);
      yield* getState;
      yield* Effect.addFinalizer(() =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            // Do not open a new client just to close it. A current policy or
            // identity change discards the previous queue instead of flushing it.
            const next = yield* snapshot;
            if (active?.key !== next.key) yield* invalidate;
            const sink = active?.sink;
            if (sink)
              yield* Effect.tryPromise(() => sink.shutdown(2_000)).pipe(
                // Scope finalizers are uninterruptible by default. The flush
                // must remain interruptible for this deadline to take effect.
                Effect.interruptible,
                Effect.timeout('2 seconds'),
                Effect.ignore
              );
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                closed = true;
              }).pipe(Effect.zipRight(invalidate))
            )
          )
        )
      );
      return { state, getState, capture, captureException } satisfies TelemetryServiceApi;
    })
  );
