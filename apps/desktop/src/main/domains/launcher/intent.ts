import { Deferred, Effect, Exit } from 'effect';
import type { StartRecordingOutcome } from '../recording/bridge';

export interface LauncherIntent {
  readonly id: string;
  readonly generation: number;
  readonly expires: number;
  readonly canceled: Deferred.Deferred<void>;
  windowId?: number;
  noteId?: string;
  claimed: boolean;
  finished: boolean;
}
// Boot-owned intent. A canceled window keeps its tombstone until it is destroyed,
// so an IPC already validated before Stop cannot be mistaken for a manual start.
const owners = new Map<number, LauncherIntent>();
export function bindLauncherWindow(intent: LauncherIntent, id: number) {
  intent.windowId = id;
  owners.set(id, intent);
}
export function forgetLauncherWindow(id: number) {
  owners.delete(id);
}
export function cancelLauncherIntent(intent: LauncherIntent) {
  intent.finished = true;
  Deferred.doneUnsafe(intent.canceled, Exit.succeed(undefined));
}
export function validateLauncherIntent(
  windowId: number,
  generation: number,
  id: string,
  noteId: string | null
) {
  const intent = owners.get(windowId);
  if (
    !intent ||
    intent.id !== id ||
    intent.finished ||
    intent.claimed ||
    intent.generation !== generation ||
    intent.expires <= Date.now()
  )
    return false;
  if (noteId !== null) {
    if (intent.noteId !== undefined && intent.noteId !== noteId) return false;
    intent.noteId = noteId;
  }
  return true;
}
export const guardLauncherStart = (
  windowId: number,
  generation: number,
  id: string | undefined,
  noteId: string | null,
  start: Effect.Effect<StartRecordingOutcome>
): Effect.Effect<StartRecordingOutcome> =>
  Effect.gen(function* () {
    if (!id) return yield* start;
    if (!validateLauncherIntent(windowId, generation, id, noteId) || noteId === null)
      return { ok: false, reason: 'busy' } as const;
    const intent = owners.get(windowId)!;
    intent.claimed = true;
    return yield* start.pipe(
      Effect.raceFirst(
        Deferred.await(intent.canceled).pipe(
          Effect.as<StartRecordingOutcome>({ ok: false, reason: 'busy' })
        )
      ),
      Effect.ensuring(
        Effect.sync(() => {
          cancelLauncherIntent(intent);
          if (owners.get(windowId) === intent) owners.delete(windowId);
        })
      )
    );
  });
