import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type {
  AppleCalendarPermissionStatus,
  AppleCalendarStatus,
  TransportRequest,
  TransportResponse,
} from '@prismical/desktop-contracts';
import { Data, Duration, Effect, Layer, Queue, Ref, Stream } from 'effect';
import { WorkspaceBackend } from '../transport/service';
import { EventKitBridge } from './bridge';
import { EventKitService, type EventKitServiceApi } from './service';
import {
  getEventKitPermission,
  listEventKitCalendars,
  readEventKitSnapshot,
  requestEventKitPermission,
  unavailableAppleCalendarStatus,
  watchEventKitChanges,
  type EventKitEvent,
} from '../../infra/eventkit/client';
import { AppConfig } from '../../infra/config/service';
import { MainLogger } from '../../infra/logging/service';
import { OperationalDb } from '../../infra/operational-db/service';
import { SignedInSession } from '../../runtime/workspace-layer';

const DEVICE_ID_SETTING = 'eventkit:device-id';
const REFRESH_INTERVAL = Duration.minutes(15);
const WINDOW_BACK_MS = 7 * 86_400_000;
const WINDOW_FORWARD_MS = 30 * 86_400_000;
const EVENTS_PER_CHUNK = 200;
const MAX_CHUNK_BYTES = 450 * 1024;
const MAX_CHUNKS = 500;

class EventKitSyncError extends Data.TaggedError('EventKitSyncError')<{
  readonly operation: string;
  readonly detail?: string;
}> {}

/** Split by count and encoded bytes so every chunk stays below Fastify's body limit. */
export function chunkEventKitEvents(events: readonly EventKitEvent[]): EventKitEvent[][] {
  if (events.length === 0) return [[]];
  const chunks: EventKitEvent[][] = [];
  let current: EventKitEvent[] = [];
  for (const event of events) {
    const candidate = [...current, event];
    const candidateBytes = Buffer.byteLength(JSON.stringify({ events: candidate }), 'utf8');
    if (
      current.length > 0 &&
      (current.length >= EVENTS_PER_CHUNK || candidateBytes > MAX_CHUNK_BYTES)
    ) {
      chunks.push(current);
      current = [event];
    } else {
      current = candidate;
    }
    if (Buffer.byteLength(JSON.stringify({ events: current }), 'utf8') > MAX_CHUNK_BYTES) {
      throw new EventKitSyncError({
        operation: 'chunk-events',
        detail: 'one normalized event exceeds the upload limit',
      });
    }
    if (chunks.length >= MAX_CHUNKS) {
      throw new EventKitSyncError({
        operation: 'chunk-events',
        detail: 'snapshot requires too many chunks',
      });
    }
  }
  if (current.length > 0) chunks.push(current);
  if (chunks.length > MAX_CHUNKS) {
    throw new EventKitSyncError({
      operation: 'chunk-events',
      detail: 'snapshot requires too many chunks',
    });
  }
  return chunks;
}

function responseBody<T>(
  operation: string,
  response: TransportResponse
): Effect.Effect<T, EventKitSyncError> {
  if ('error' in response) {
    return Effect.fail(new EventKitSyncError({ operation, detail: response.error.code }));
  }
  if (response.status < 200 || response.status >= 300) {
    return Effect.fail(new EventKitSyncError({ operation, detail: `http-${response.status}` }));
  }
  return Effect.succeed(response.bodyJson as T);
}

export const EventKitServiceLive: Layer.Layer<
  EventKitService,
  never,
  WorkspaceBackend | EventKitBridge | OperationalDb | MainLogger | AppConfig | SignedInSession
> = Layer.scoped(
  EventKitService,
  Effect.gen(function* () {
    const core = yield* WorkspaceBackend;
    const bridge = yield* EventKitBridge;
    const operationalDb = yield* OperationalDb;
    const config = yield* AppConfig;
    const session = yield* SignedInSession;
    const log = (yield* MainLogger).scoped('eventkit');
    const initial =
      config.platform === 'darwin'
        ? {
            permission: 'unknown' as const,
            state: 'disabled' as const,
            lastRefreshedAt: null,
            error: null,
          }
        : unavailableAppleCalendarStatus;
    const status = yield* Ref.make<AppleCalendarStatus>(initial);
    const semaphore = yield* Effect.makeSemaphore(1);
    const startWatcher = yield* Queue.sliding<void>(1);
    const eventKitChanges = yield* Queue.sliding<void>(1);

    const request = <T>(operation: string, spec: TransportRequest) =>
      core.request(spec).pipe(Effect.flatMap(response => responseBody<T>(operation, response)));

    const getDeviceId = operationalDb.getSetting(DEVICE_ID_SETTING).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
      Effect.flatMap(existing => {
        if (existing) return Effect.succeed(existing);
        const id = randomUUID();
        return operationalDb.setSetting(DEVICE_ID_SETTING, id).pipe(
          Effect.as(id),
          Effect.catchAll(() => Effect.succeed(id))
        );
      })
    );

    const getCapability = request<{ available?: unknown; enabled?: unknown }>('capability', {
      method: 'GET',
      path: '/apps/v1/me/eventkit/capability',
    }).pipe(
      Effect.map(body => ({
        available: body.available === true,
        enabled: body.enabled === true,
      }))
    );

    const setPermissionState = (
      permission: AppleCalendarPermissionStatus
    ): Effect.Effect<AppleCalendarStatus> =>
      Ref.updateAndGet(
        status,
        (current): AppleCalendarStatus => ({
          ...current,
          permission,
          state: permission === 'granted' ? 'ready' : 'disabled',
          error: null,
        })
      );

    const sync = semaphore.withPermits(1)(
      Effect.gen(function* () {
        if (config.platform !== 'darwin') return unavailableAppleCalendarStatus;
        const capability = yield* getCapability;
        if (!capability.available || !capability.enabled) {
          return yield* Ref.updateAndGet(
            status,
            (current): AppleCalendarStatus => ({
              ...current,
              state: 'disabled',
              error: null,
            })
          );
        }
        const permission = yield* getEventKitPermission().pipe(
          Effect.mapError(() => new EventKitSyncError({ operation: 'permission-status' }))
        );
        yield* setPermissionState(permission);
        if (permission !== 'granted') return yield* Ref.get(status);

        yield* Ref.update(
          status,
          (current): AppleCalendarStatus => ({ ...current, state: 'syncing', error: null })
        );
        const deviceId = yield* getDeviceId;
        const calendars = yield* listEventKitCalendars().pipe(
          Effect.mapError(() => new EventKitSyncError({ operation: 'list-calendars' }))
        );
        yield* request('register-device', {
          method: 'PUT',
          path: `/apps/v1/me/eventkit/devices/${encodeURIComponent(deviceId)}`,
          body: {
            deviceName: os.hostname().slice(0, 128) || 'This Mac',
            calendars,
          },
        });
        const configBody = yield* request<{
          result?: {
            enabledCalendarExternalIds?: unknown;
            lastSequence?: unknown;
          };
        }>('device-config', {
          method: 'GET',
          path: `/apps/v1/me/eventkit/devices/${encodeURIComponent(deviceId)}/config`,
        });
        const enabledCalendarExternalIds = Array.isArray(
          configBody.result?.enabledCalendarExternalIds
        )
          ? configBody.result.enabledCalendarExternalIds.filter(
              (value): value is string => typeof value === 'string'
            )
          : [];
        if (enabledCalendarExternalIds.length === 0) {
          return yield* Ref.updateAndGet(
            status,
            (current): AppleCalendarStatus => ({
              ...current,
              state: 'ready',
              error: null,
            })
          );
        }

        const now = Date.now();
        const windowStart = new Date(now - WINDOW_BACK_MS).toISOString();
        const windowEnd = new Date(now + WINDOW_FORWARD_MS).toISOString();
        const events = yield* readEventKitSnapshot({
          start: windowStart,
          end: windowEnd,
          calendarExternalIds: enabledCalendarExternalIds,
        }).pipe(Effect.mapError(() => new EventKitSyncError({ operation: 'read-snapshot' })));

        const sequenceKey = `eventkit:sequence:${session.pinned.sub}:${session.pinned.activeOrgId ?? 'default'}`;
        const localSequence = yield* operationalDb.getSetting(sequenceKey).pipe(
          Effect.map(value => {
            const parsed = Number(value);
            return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : -1;
          }),
          Effect.catchAll(() => Effect.succeed(-1))
        );
        const serverSequence =
          typeof configBody.result?.lastSequence === 'number' &&
          Number.isSafeInteger(configBody.result.lastSequence)
            ? configBody.result.lastSequence
            : -1;
        const sequence = Math.max(localSequence, serverSequence) + 1;
        yield* operationalDb
          .setSetting(sequenceKey, String(sequence))
          .pipe(Effect.catchAll(() => Effect.void));

        const chunks = chunkEventKitEvents(events);
        const begin = yield* request<{ result?: { snapshotId?: unknown } }>('begin-snapshot', {
          method: 'POST',
          path: `/apps/v1/me/eventkit/devices/${encodeURIComponent(deviceId)}/snapshots`,
          body: {
            sequence,
            capturedAt: new Date(now).toISOString(),
            windowStart,
            windowEnd,
            expectedChunks: chunks.length,
            expectedEvents: events.length,
          },
        });
        const snapshotId = begin.result?.snapshotId;
        if (typeof snapshotId !== 'string') {
          return yield* Effect.fail(
            new EventKitSyncError({ operation: 'begin-snapshot', detail: 'missing-id' })
          );
        }
        for (let index = 0; index < chunks.length; index++) {
          yield* request('put-snapshot-chunk', {
            method: 'PUT',
            path: `/apps/v1/me/eventkit/snapshots/${encodeURIComponent(snapshotId)}/chunks/${index}`,
            body: { events: chunks[index] },
          });
        }
        yield* request('commit-snapshot', {
          method: 'POST',
          path: `/apps/v1/me/eventkit/snapshots/${encodeURIComponent(snapshotId)}/commit`,
        });
        return yield* Ref.updateAndGet(
          status,
          (current): AppleCalendarStatus => ({
            ...current,
            permission: 'granted',
            state: 'ready',
            lastRefreshedAt: new Date().toISOString(),
            error: null,
          })
        );
      }).pipe(
        Effect.catchAll(error =>
          log
            .error('Apple Calendar refresh failed', {
              operation: error instanceof EventKitSyncError ? error.operation : 'helper',
            })
            .pipe(
              Effect.zipRight(
                Ref.updateAndGet(
                  status,
                  (current): AppleCalendarStatus => ({
                    ...current,
                    state: 'error',
                    error: 'Could not refresh Apple Calendar',
                  })
                )
              )
            )
        )
      )
    );

    const enable = semaphore
      .withPermits(1)(
        Effect.gen(function* () {
          if (config.platform !== 'darwin') return unavailableAppleCalendarStatus;
          const capability = yield* getCapability.pipe(
            Effect.catchAll(() => Effect.succeed({ available: false, enabled: false }))
          );
          if (!capability.available) {
            return yield* Ref.updateAndGet(
              status,
              (current): AppleCalendarStatus => ({
                ...current,
                state: 'disabled',
                error: 'Apple Calendar is not enabled for this account',
              })
            );
          }
          const permission = yield* requestEventKitPermission().pipe(
            Effect.catchAll(() => Effect.succeed<AppleCalendarPermissionStatus>('unknown'))
          );
          yield* setPermissionState(permission);
          if (permission === 'granted') {
            yield* request('enable-integration', {
              method: 'PUT',
              path: '/apps/v1/me/eventkit/integration',
              body: {},
            });
            yield* Queue.offer(startWatcher, undefined);
          }
          return yield* Ref.get(status);
        })
      )
      .pipe(
        Effect.flatMap(result => (result.permission === 'granted' ? sync : Effect.succeed(result))),
        Effect.catchAll(error =>
          log
            .error('Apple Calendar connect failed', {
              operation: error instanceof EventKitSyncError ? error.operation : 'enable',
            })
            .pipe(
              Effect.zipRight(
                Ref.updateAndGet(
                  status,
                  (current): AppleCalendarStatus => ({
                    ...current,
                    state: 'error',
                    error: 'Could not connect Apple Calendar',
                  })
                )
              )
            )
        )
      );

    const api: EventKitServiceApi = {
      getStatus: Ref.get(status),
      enable,
      refresh: sync,
    };
    yield* bridge.register(api);

    // Permission is read-only at startup; the OS prompt is reachable only from
    // `enable`, which is called by an explicit renderer click.
    if (config.platform === 'darwin') {
      yield* Effect.forkScoped(
        Queue.take(startWatcher).pipe(
          Effect.zipRight(
            watchEventKitChanges(() => {
              Queue.unsafeOffer(eventKitChanges, undefined);
            })
          ),
          Effect.catchAll(error =>
            log.warn('Apple Calendar change watcher stopped', {
              operation: error.operation,
            })
          )
        )
      );
      yield* Effect.forkScoped(
        Stream.fromQueue(eventKitChanges).pipe(
          Stream.debounce(Duration.seconds(3)),
          Stream.runForEach(() => sync)
        )
      );
      const initialPermission = yield* getEventKitPermission().pipe(
        Effect.flatMap(setPermissionState),
        Effect.catchAll(() => Ref.get(status))
      );
      if (initialPermission.permission === 'granted') {
        yield* Queue.offer(startWatcher, undefined);
      }
      yield* Effect.forkScoped(sync);
      yield* Effect.forkScoped(
        Effect.sleep(REFRESH_INTERVAL).pipe(Effect.zipRight(sync), Effect.forever)
      );
    }
    return api;
  })
);
