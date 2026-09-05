import { describe, expect, it, vi } from 'vitest';
import type { EventKitEvent } from '../../src/main/infra/eventkit/client';
import { Context, Deferred, Effect, Layer } from 'effect';
import type { TransportRequest } from '@prismical/desktop-contracts';
import { EventKitBridgeLive } from '../../src/main/domains/eventkit/bridge';
import { EventKitService } from '../../src/main/domains/eventkit/service';
import { WorkspaceBackend } from '../../src/main/domains/transport/service';
import { OperationalDbLive } from '../../src/main/infra/operational-db/live';
import { SignedInSession } from '../../src/main/runtime/workspace-layer';
import { makeTestLogger, recordingLaneStub, testConfigLayer } from '../helpers/test-layers';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());
vi.mock('../../src/main/infra/eventkit/client', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/main/infra/eventkit/client')>();
  return {
    ...original,
    getEventKitPermission: () => Effect.succeed('granted'),
    listEventKitCalendars: () => Effect.succeed([]),
    readEventKitSnapshot: vi.fn(() => Effect.succeed([event(1)])),
    watchEventKitChanges: () => Effect.never,
  };
});

const { chunkEventKitEvents, EventKitServiceLive } =
  await import('../../src/main/domains/eventkit/live');
const { readEventKitSnapshot } = await import('../../src/main/infra/eventkit/client');

function event(index: number, description = ''): EventKitEvent {
  return {
    calendarExternalId: 'calendar-1',
    sourceEventId: `event-${index}`,
    icalUid: `ical-${index}`,
    recurrenceId: 'single',
    title: `Event ${index}`,
    description,
    startsAt: '2026-07-28T12:00:00.000Z',
    endsAt: '2026-07-28T12:30:00.000Z',
    isAllDay: false,
    status: 'confirmed',
    meetingUrl: null,
    location: null,
    organizer: null,
    attendees: null,
    sourceUpdatedAt: null,
  };
}

describe('EventKit snapshot chunking', () => {
  it('sends one empty chunk for an authoritative empty snapshot', () => {
    expect(chunkEventKitEvents([])).toEqual([[]]);
  });

  it('caps a chunk at 200 events', () => {
    const chunks = chunkEventKitEvents(Array.from({ length: 201 }, (_, index) => event(index)));
    expect(chunks.map(chunk => chunk.length)).toEqual([200, 1]);
  });

  it('splits on encoded bytes before Fastify body parsing', () => {
    const description = 'x'.repeat(20_000);
    const chunks = chunkEventKitEvents(
      Array.from({ length: 30 }, (_, index) => event(index, description))
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(JSON.stringify({ events: chunk }), 'utf8')).toBeLessThanOrEqual(
        450 * 1024
      );
    }
  });
});

it('refreshes enabled calendars using direct config and snapshot responses', async () => {
  const calls: TransportRequest[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const startup = yield* Deferred.make<void>();
        let enabled = false;
        const prefix = '/apps/v1/me/eventkit';
        const env = Layer.mergeAll(
          testConfigLayer({ platform: 'darwin' }),
          makeTestLogger().layer,
          EventKitBridgeLive,
          Layer.succeed(SignedInSession, {
            pinned: { sub: 'calendar-user', email: 'calendar@example.com' },
            idToken: Effect.succeed('calendar-token'),
          }),
          Layer.succeed(WorkspaceBackend, {
            ...recordingLaneStub,
            openAskStream: () => Effect.die('unexpected Ask request'),
            collabToken: Effect.die('unexpected collaboration request'),
            request: req =>
              Effect.gen(function* () {
                calls.push(req);
                let bodyJson: unknown = {};
                if (req.path === `${prefix}/capability`) {
                  bodyJson = { available: true, enabled };
                  yield* Deferred.succeed(startup, undefined);
                } else if (req.path.endsWith('/config')) {
                  bodyJson = {
                    connectionId: 'connection-1',
                    enabledCalendarExternalIds: ['calendar-1'],
                    lastSequence: 41,
                    windowBackDays: 7,
                    windowForwardDays: 30,
                  };
                } else if (req.path.endsWith('/snapshots')) {
                  bodyJson = { snapshotId: 'snapshot-1', status: 'pending' };
                } else if (req.path.endsWith('/chunks/0')) {
                  bodyJson = { checksum: 'checksum-1', accepted: true };
                } else if (req.path.endsWith('/commit')) {
                  bodyJson = { committed: true, eventCount: 1 };
                }
                return { ok: true as const, status: 200, bodyJson };
              }),
          })
        );
        const ctx = yield* Layer.build(
          EventKitServiceLive.pipe(Layer.provide(OperationalDbLive), Layer.provide(env))
        );
        yield* Deferred.await(startup);
        enabled = true;
        const result = yield* Context.get(ctx, EventKitService).refresh;
        expect(result).toMatchObject({ state: 'ready', error: null });
        expect(result.lastRefreshedAt).toEqual(expect.any(String));
        expect(readEventKitSnapshot).toHaveBeenCalledWith(
          expect.objectContaining({
            calendarExternalIds: ['calendar-1'],
          })
        );
        expect(calls.find(call => call.path.endsWith('/snapshots'))?.body).toMatchObject({
          sequence: 42,
          expectedChunks: 1,
          expectedEvents: 1,
        });
        expect(calls).toContainEqual({
          method: 'PUT',
          path: `${prefix}/snapshots/snapshot-1/chunks/0`,
          body: { events: [event(1)] },
        });
        expect(calls).toContainEqual({
          method: 'POST',
          path: `${prefix}/snapshots/snapshot-1/commit`,
        });
      })
    )
  );
});
