/**
 * RecordingBridge — the boot↔workspace bridge for the
 * record button, the exact analogue of WorkspaceTransport (domains/transport).
 *
 * The RecordingService is WORKSPACE-scoped (it mounts in the workspace layer so
 * every recording fiber tears down with the workspace — sign-out, org-switch or
 * quit). The IPC handlers are BOOT-scoped (registered before the window paints).
 * This leaf sits in the boot scope holding the CURRENT workspace's
 * RecordingService: the workspace-scoped service self-publishes here on acquire
 * (compare-and-clear on release), so the boot-scoped `recording:start` /
 * `recording:stop` handlers and the `recording:stateChanged` push fiber reach
 * the live workspace without owning its scope — and with no workspace mounted
 * they settle gracefully (no-session / idle), never a throw. (The wire literal
 * stays 'no-session' — the renderer folds on it.)
 */
import { Context, Effect, Layer, Option, Stream, SubscriptionRef, type Scope } from 'effect';
import {
  idleRecordingState,
  type RecordingServiceApi,
  type RecordingState,
  type StartRecordingInput,
} from './service';

/**
 * Why a start did not begin (never fails — the handler renders the reason):
 * `permission-denied` the mic is required but denied (no capture spawned);
 * `busy` a recording is already active (Semaphore(1)); `no-session` no mounted
 * workspace to record under (the record button shouldn't reach here without one).
 */
export type StartRecordingOutcome =
  | { readonly ok: true; readonly recordingId: string }
  | {
      readonly ok: false;
      readonly reason:
        | 'permission-denied'
        | 'busy'
        | 'no-session'
        | 'model-missing'
        | 'storage-unavailable';
    };

export interface RecordingBridgeApi {
  /**
   * Workspace-scoped: publish `service` as the current workspace's RecordingService
   * for the enclosing Scope; the finalizer clears it (compare-and-clear so a slow
   * old-workspace teardown that releases AFTER a successor registered does not
   * clobber the live service — recording teardown is slow).
   */
  readonly register: (service: RecordingServiceApi) => Effect.Effect<void, never, Scope.Scope>;
  /** Start via the current workspace's service; folds every failure to an outcome. */
  readonly start: (input: StartRecordingInput) => Effect.Effect<StartRecordingOutcome>;
  /** Stop via the current workspace; a no-op when none is mounted or the id is stale. */
  readonly stop: (recordingId: string) => Effect.Effect<void>;
  readonly claimCompletion: (recordingId: string) => Effect.Effect<boolean>;
  /** Pause/resume a matching recording; false when no workspace/id/state accepts it. */
  readonly pause: (recordingId: string) => Effect.Effect<boolean>;
  readonly resume: (recordingId: string) => Effect.Effect<boolean>;
  /**
   * Stop whatever recording is currently active, without the caller knowing its
   * id (the widget's no-arg Stop): reads the live workspace's state and stops the
   * active recording iff one is starting/recording/paused. A no-op when no workspace
   * is mounted or nothing is in flight.
   */
  readonly stopActive: Effect.Effect<void>;
  /**
   * Pause / resume the active recording for the id-less widget surface.
   */
  readonly pauseActive: Effect.Effect<void>;
  readonly resumeActive: Effect.Effect<void>;
  /**
   * "Keep recording" on the auto-pause prompt — suppresses auto-pause for the rest
   * of the active recording session. No-op when nothing is recording.
   */
  readonly keepRecordingActive: Effect.Effect<void>;
  /** The auto-pause prompt's Pause button — a consented, user-attributed pause. */
  readonly pauseFromPromptActive: Effect.Effect<void>;
  /**
   * The ACTIVE recording's note id, or null (idle / no workspace / no note) —
   * a synchronous pull for consumers that must not race the push lanes (the
   * FloatBridge resolves the slot-less 📓 against this).
   */
  readonly activeNoteId: Effect.Effect<string | null>;
  /**
   * A single RecordingState stream flattened across workspaces: emits
   * `idleRecordingState` while no workspace is mounted, and the live workspace's
   * state.changes otherwise (switching on each workspace swap so a torn-down
   * workspace's state never leaks into the next). The push fiber runs this to the window.
   */
  readonly stateChanges: Stream.Stream<RecordingState>;
  /**
   * The live capture level flattened across workspaces: 0 while
   * no workspace is mounted, the live workspace's smoothed RMS otherwise. Un-throttled —
   * the dock's push fiber owns the wire cadence.
   */
  readonly levelChanges: Stream.Stream<number>;
}

export class RecordingBridge extends Context.Tag('desktop/recording/RecordingBridge')<
  RecordingBridge,
  RecordingBridgeApi
>() {}

export const RecordingBridgeLive: Layer.Layer<RecordingBridge> = Layer.effect(
  RecordingBridge,
  Effect.gen(function* () {
    const currentRef = yield* SubscriptionRef.make<Option.Option<RecordingServiceApi>>(
      Option.none()
    );

    const api: RecordingBridgeApi = {
      register: service =>
        Effect.acquireRelease(SubscriptionRef.set(currentRef, Option.some(service)), () =>
          SubscriptionRef.update(currentRef, cur =>
            Option.exists(cur, s => s === service) ? Option.none() : cur
          )
        ).pipe(Effect.asVoid),

      start: input =>
        SubscriptionRef.get(currentRef).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.succeed<StartRecordingOutcome>({ ok: false, reason: 'no-session' }),
              onSome: service =>
                service.start(input).pipe(
                  Effect.map((recordingId): StartRecordingOutcome => ({ ok: true, recordingId })),
                  Effect.catchTag('RecordingBusyError', () =>
                    Effect.succeed<StartRecordingOutcome>({ ok: false, reason: 'busy' })
                  ),
                  Effect.catchTag('RecordingStartError', error =>
                    Effect.succeed<StartRecordingOutcome>({ ok: false, reason: error.reason })
                  ),
                  Effect.catchTag('PermissionError', () =>
                    Effect.succeed<StartRecordingOutcome>({
                      ok: false,
                      reason: 'permission-denied',
                    })
                  )
                ),
            })
          )
        ),

      stop: recordingId =>
        SubscriptionRef.get(currentRef).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: service => service.stop(recordingId),
            })
          )
        ),

      claimCompletion: recordingId =>
        SubscriptionRef.get(currentRef).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(false),
              onSome: service => service.claimCompletion(recordingId),
            })
          )
        ),

      pause: recordingId =>
        SubscriptionRef.get(currentRef).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(false),
              onSome: service => service.pause(recordingId),
            })
          )
        ),

      resume: recordingId =>
        SubscriptionRef.get(currentRef).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(false),
              onSome: service => service.resume(recordingId),
            })
          )
        ),

      stopActive: SubscriptionRef.get(currentRef).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: service =>
              SubscriptionRef.get(service.state).pipe(
                Effect.flatMap(state =>
                  state.recordingId !== null &&
                  (state.status === 'starting' ||
                    state.status === 'recording' ||
                    state.status === 'paused')
                    ? service.stop(state.recordingId)
                    : Effect.void
                )
              ),
          })
        )
      ),

      pauseActive: SubscriptionRef.get(currentRef).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: service =>
              SubscriptionRef.get(service.state).pipe(
                Effect.flatMap(state =>
                  state.recordingId !== null && state.status === 'recording'
                    ? service.pause(state.recordingId).pipe(Effect.asVoid)
                    : Effect.void
                )
              ),
          })
        )
      ),
      pauseFromPromptActive: SubscriptionRef.get(currentRef).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: service =>
              SubscriptionRef.get(service.state).pipe(
                Effect.flatMap(state =>
                  state.recordingId !== null && state.status === 'recording'
                    ? service.pauseFromPrompt(state.recordingId).pipe(Effect.asVoid)
                    : Effect.void
                )
              ),
          })
        )
      ),
      keepRecordingActive: SubscriptionRef.get(currentRef).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: service =>
              SubscriptionRef.get(service.state).pipe(
                Effect.flatMap(state =>
                  state.recordingId !== null
                    ? service.keepRecording(state.recordingId).pipe(Effect.asVoid)
                    : Effect.void
                )
              ),
          })
        )
      ),
      resumeActive: SubscriptionRef.get(currentRef).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: service =>
              SubscriptionRef.get(service.state).pipe(
                Effect.flatMap(state =>
                  state.recordingId !== null && state.status === 'paused'
                    ? service.resume(state.recordingId).pipe(Effect.asVoid)
                    : Effect.void
                )
              ),
          })
        )
      ),

      activeNoteId: SubscriptionRef.get(currentRef).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed<string | null>(null),
            onSome: service =>
              SubscriptionRef.get(service.state).pipe(
                Effect.map(state =>
                  state.status === 'starting' ||
                  state.status === 'recording' ||
                  state.status === 'paused' ||
                  state.status === 'stopping'
                    ? state.noteId
                    : null
                )
              ),
          })
        )
      ),

      // switch:true — a workspace swap interrupts the old workspace's inner stream
      // and starts the new one (or the idle stream), so the renderer resets to idle
      // when the workspace unmounts and never sees a dead workspace's state.
      stateChanges: currentRef.changes.pipe(
        Stream.flatMap(
          Option.match({
            onNone: () => Stream.succeed(idleRecordingState),
            onSome: service => service.state.changes,
          }),
          { switch: true }
        )
      ),
      levelChanges: currentRef.changes.pipe(
        Stream.flatMap(
          Option.match({
            onNone: () => Stream.succeed(0),
            onSome: service => service.level.changes,
          }),
          { switch: true }
        )
      ),
    };
    return api;
  })
);
