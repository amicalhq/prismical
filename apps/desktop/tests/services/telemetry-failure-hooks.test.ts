import { EventEmitter } from 'node:events';
import { Effect, Option, SubscriptionRef } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { registerFailureHooks } from '../../src/main/domains/telemetry/failure-hooks';
import {
  TelemetryService,
  type TelemetryEventProperties,
  type TelemetrySource,
} from '../../src/main/domains/telemetry/service';
import { WindowRegistry, type WindowRegistryService } from '../../src/main/domains/windows/service';
import type { WindowKind } from '../../src/main/domains/windows/policy';
import { makeTestLogger } from '../helpers/test-layers';

class Contents extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
}

const fixture = () => ({
  app: new EventEmitter(),
  process: new EventEmitter(),
  existing: new Contents(1),
  logger: makeTestLogger(),
  reports: [] as Array<{
    error: unknown;
    properties?: TelemetryEventProperties;
    source?: TelemetrySource;
    revision?: number;
  }>,
  kinds: new Map<number, WindowKind>([
    [1, 'main'],
    [2, 'widget'],
    [3, 'notify'],
    [4, 'float-note'],
  ]),
  failTelemetry: false,
  captureAttempts: 0,
});

const withHooks = (
  f: ReturnType<typeof fixture>,
  test: (
    state: SubscriptionRef.SubscriptionRef<{
      available: boolean;
      enabled: boolean;
      signedIn: boolean;
      preference: boolean;
      canChangePreference: boolean;
      revision: number;
    }>
  ) => Promise<void>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const policy = {
          available: true,
          enabled: true,
          signedIn: false,
          preference: true,
          canChangePreference: true,
          revision: 0,
        };
        const state = yield* SubscriptionRef.make(policy);
        yield* registerFailureHooks({
          app: f.app,
          process: f.process,
          existingWebContents: [f.existing],
        }).pipe(
          Effect.provide(f.logger.layer),
          Effect.provideService(TelemetryService, {
            state,
            getState: Effect.succeed(policy),
            capture: () => Effect.void,
            captureException: (error, properties, source, revision) =>
              Effect.sync(() => {
                f.captureAttempts++;
                if (f.failTelemetry) throw new Error('SDK failed');
                f.reports.push({ error, properties, source, revision });
              }),
          }),
          Effect.provideService(WindowRegistry, {
            identityForWebContents: id =>
              Effect.succeed(
                Option.fromNullable(
                  f.kinds.has(id)
                    ? { windowId: id, webContentsId: id, kind: f.kinds.get(id)! }
                    : undefined
                )
              ),
          } as WindowRegistryService)
        );
        yield* Effect.promise(() => test(state));
      })
    )
  );

describe('scoped desktop failure hooks', () => {
  it('observes uncaught exceptions without installing swallowing listeners and writes local evidence immediately', async () => {
    const f = fixture();
    await withHooks(f, async () => {
      expect(f.process.listenerCount('uncaughtException')).toBe(0);
      expect(f.process.listenerCount('unhandledRejection')).toBe(0);
      f.process.emit(
        'uncaughtExceptionMonitor',
        new TypeError('private transcript'),
        'unhandledRejection'
      );
      expect(f.logger.entries).toHaveLength(1);
      expect(f.logger.entries[0]?.message).toBe('uncaught main process exception');
      expect(JSON.stringify(f.logger.entries)).not.toContain('private transcript');
      await vi.waitFor(() => expect(f.reports).toHaveLength(1));
      expect(f.reports[0]).toMatchObject({
        source: 'main',
        properties: { source: 'main-process', error_context: 'unhandled_rejection' },
      });
    });
    expect(f.process.listenerCount('uncaughtExceptionMonitor')).toBe(0);
  });

  it('binds queued failures to occurrence policy and keeps disabled failures local', async () => {
    const f = fixture();
    await withHooks(f, async state => {
      const initial = Effect.runSync(SubscriptionRef.get(state));
      f.app.emit('child-process-gone', {}, { reason: 'crashed', exitCode: 1, type: 'GPU' });
      Effect.runSync(SubscriptionRef.set(state, { ...initial, enabled: false, revision: 1 }));
      f.app.emit('child-process-gone', {}, { reason: 'oom', exitCode: 2, type: 'GPU' });
      await vi.waitFor(() => expect(f.reports).toHaveLength(1));
      expect(f.reports[0]?.revision).toBe(0);
      expect(f.logger.entries).toHaveLength(2);
    });
  });

  it('reports existing and newly created windows, including widget, notify and floating notes', async () => {
    const f = fixture();
    await withHooks(f, async () => {
      const contents = [f.existing, new Contents(2), new Contents(3), new Contents(4)];
      for (const child of contents.slice(1)) f.app.emit('web-contents-created', {}, child);
      // Duplicate attachment must not produce a duplicate report.
      f.app.emit('web-contents-created', {}, f.existing);
      for (const child of contents)
        child.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 });
      await vi.waitFor(() => expect(f.reports).toHaveLength(4));
      expect(f.reports.map(r => r.properties?.window_type)).toEqual([
        'main',
        'widget',
        'notify',
        'float-note',
      ]);
      expect(f.reports.every(r => r.source === 'main')).toBe(true);
    });
    expect(f.existing.listenerCount('render-process-gone')).toBe(0);
    expect(f.app.listenerCount('web-contents-created')).toBe(0);
  });

  it('ignores clean exits, aborted navigation and subframes; excludes failing URLs and preload paths', async () => {
    const f = fixture();
    await withHooks(f, async () => {
      f.existing.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
      f.app.emit('child-process-gone', {}, { reason: 'clean-exit', exitCode: 0, type: 'GPU' });
      f.existing.emit('did-fail-load', {}, -3, 'aborted', 'https://secret', true);
      f.existing.emit('did-fail-load', {}, -2, 'subframe', 'https://secret', false);
      expect(f.logger.entries).toHaveLength(0);
      f.existing.emit(
        'did-fail-load',
        {},
        -6,
        'secret description',
        'https://private?token=secret',
        true
      );
      f.existing.emit('preload-error', {}, '/Users/private/preload.js', new Error('secret token'));
      await vi.waitFor(() => expect(f.reports).toHaveLength(2));
      expect(f.reports.map(r => r.properties?.source)).toEqual(['window-load', 'preload']);
      expect(JSON.stringify([f.reports, f.logger.entries])).not.toMatch(/secret|Users\/private/);
    });
  });

  it('reports child failures once without copying arbitrary process details', async () => {
    const f = fixture();
    await withHooks(f, async () => {
      f.app.emit(
        'child-process-gone',
        {},
        { reason: 'oom', exitCode: 137, type: 'Utility', serviceName: 'secret', name: 'secret' }
      );
      await vi.waitFor(() => expect(f.reports).toHaveLength(1));
      expect(f.reports[0]).toMatchObject({
        source: 'main',
        properties: {
          source: 'child-process',
          reason: 'oom',
          exit_code: 137,
          process_type: 'Utility',
        },
      });
      expect(JSON.stringify(f.reports)).not.toContain('secret');
    });
    expect(f.app.listenerCount('child-process-gone')).toBe(0);
  });

  it('removes destroyed-window listeners and all listeners on scope close', async () => {
    const f = fixture();
    const child = new Contents(2);
    await withHooks(f, async () => {
      f.app.emit('web-contents-created', {}, child);
      child.emit('destroyed');
      expect(child.eventNames()).toEqual([]);
      child.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
      expect(f.logger.entries).toHaveLength(0);
    });
    expect(f.existing.eventNames()).toEqual([]);
    f.process.emit('uncaughtExceptionMonitor', new Error('late'), 'uncaughtException');
    f.app.emit('web-contents-created', {}, child);
    expect(f.logger.entries).toHaveLength(0);
    expect(child.eventNames()).toEqual([]);
  });

  it('keeps local evidence and continues listening after telemetry fails', async () => {
    const f = fixture();
    await withHooks(f, async () => {
      f.failTelemetry = true;
      f.app.emit('child-process-gone', {}, { reason: 'crashed', exitCode: 1, type: 'GPU' });
      await vi.waitFor(() => expect(f.captureAttempts).toBe(1));
      f.failTelemetry = false;
      f.app.emit('child-process-gone', {}, { reason: 'oom', exitCode: 2, type: 'GPU' });
      await vi.waitFor(() => expect(f.reports).toHaveLength(1));
      expect(f.logger.entries).toHaveLength(2);
      expect(f.reports[0]?.properties?.reason).toBe('oom');
    });
  });
});
