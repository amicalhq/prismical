import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Data, Effect, Scope } from 'effect';
import type {
  AppleCalendarPermissionStatus,
  AppleCalendarStatus,
} from '@prismical/desktop-contracts';
import { assertEventKitBinaryExists } from './eventkit-binary';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface EventKitCalendar {
  readonly externalId: string;
  readonly title: string;
  readonly color: string | null;
  readonly sourceTitle: string | null;
  readonly sourceType: string | null;
  readonly allowsContentModifications: boolean;
  readonly primary: boolean;
}

export interface EventKitEvent {
  readonly calendarExternalId: string;
  readonly sourceEventId: string;
  readonly icalUid: string | null;
  readonly recurrenceId: string;
  readonly title: string;
  readonly description: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly isAllDay: boolean;
  readonly status: 'confirmed' | 'tentative';
  readonly meetingUrl: string | null;
  readonly location: string | null;
  readonly organizer: unknown;
  readonly attendees: unknown;
  readonly sourceUpdatedAt: string | null;
}

export class EventKitHelperError extends Data.TaggedError('EventKitHelperError')<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

function runJson<T>(operation: string, args: string[]): Effect.Effect<T, EventKitHelperError> {
  return Effect.tryPromise({
    try: async signal => {
      const binary = assertEventKitBinaryExists();
      const { stdout } = await execFileAsync(binary, args, {
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        signal,
      });
      return JSON.parse(stdout) as T;
    },
    catch: cause => new EventKitHelperError({ operation, cause }),
  });
}

export function getEventKitPermission(): Effect.Effect<
  AppleCalendarPermissionStatus,
  EventKitHelperError
> {
  return runJson<{ authorizationStatus?: unknown }>('status', ['status']).pipe(
    Effect.map(result => {
      const status = result.authorizationStatus;
      return status === 'granted' ||
        status === 'denied' ||
        status === 'not-determined' ||
        status === 'restricted' ||
        status === 'write-only' ||
        status === 'unknown'
        ? status
        : 'unknown';
    })
  );
}

export function requestEventKitPermission(): Effect.Effect<
  AppleCalendarPermissionStatus,
  EventKitHelperError
> {
  return runJson<{ authorizationStatus?: unknown }>('authorize', ['authorize']).pipe(
    Effect.flatMap(() => getEventKitPermission())
  );
}

export function listEventKitCalendars(): Effect.Effect<EventKitCalendar[], EventKitHelperError> {
  return runJson<EventKitCalendar[]>('list-calendars', ['list-calendars']);
}

export function readEventKitSnapshot(input: {
  start: string;
  end: string;
  calendarExternalIds: readonly string[];
}): Effect.Effect<EventKitEvent[], EventKitHelperError> {
  const args = ['snapshot', '--start', input.start, '--end', input.end];
  for (const calendarId of input.calendarExternalIds) {
    args.push('--calendar', calendarId);
  }
  return runJson<{ events: EventKitEvent[] }>('snapshot', args).pipe(
    Effect.map(result => result.events)
  );
}

/**
 * Keep a lightweight helper attached to EKEventStoreChanged while the signed-in
 * desktop scope is alive. The service debounces these callbacks before taking
 * another authoritative snapshot.
 */
export function watchEventKitChanges(
  onChange: () => void
): Effect.Effect<never, EventKitHelperError, Scope.Scope> {
  const acquire = Effect.try({
    try: () =>
      spawn(assertEventKitBinaryExists(), ['watch'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    catch: cause => new EventKitHelperError({ operation: 'watch-start', cause }),
  });

  return Effect.acquireRelease(acquire, child =>
    Effect.sync(() => {
      if (!child.killed) child.kill();
    })
  ).pipe(
    Effect.flatMap(child =>
      Effect.async<never, EventKitHelperError>(resume => {
        let stdout = '';
        let stderr = '';
        const onStdout = (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          const lines = stdout.split('\n');
          stdout = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const message = JSON.parse(line) as { type?: unknown };
              if (message.type === 'changed') onChange();
            } catch {
              // Ignore malformed notification lines; a snapshot remains the
              // authority and the periodic refresh is the fallback.
            }
          }
        };
        const onStderr = (chunk: Buffer) => {
          stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2_048);
        };
        const onError = (cause: Error) =>
          resume(Effect.fail(new EventKitHelperError({ operation: 'watch', cause })));
        const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
          resume(
            Effect.fail(
              new EventKitHelperError({
                operation: 'watch',
                cause: new Error(
                  `EventKit watcher exited (${code ?? signal ?? 'unknown'}): ${stderr.trim()}`
                ),
              })
            )
          );
        child.stdout.on('data', onStdout);
        child.stderr.on('data', onStderr);
        child.once('error', onError);
        child.once('close', onClose);
        return Effect.sync(() => {
          child.stdout.off('data', onStdout);
          child.stderr.off('data', onStderr);
          child.off('error', onError);
          child.off('close', onClose);
        });
      })
    )
  );
}

export const unavailableAppleCalendarStatus: AppleCalendarStatus = {
  permission: 'unavailable',
  state: 'disabled',
  lastRefreshedAt: null,
  error: null,
};
