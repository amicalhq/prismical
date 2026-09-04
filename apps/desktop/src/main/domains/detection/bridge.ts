/**
 * DetectionBridge — the boot↔workspace bridge for the
 * meeting-detection signal, the exact analogue of RecordingBridge.
 *
 * The DetectionService is WORKSPACE-scoped (it mounts in the workspace layer so the
 * native mic-detector child tears down with the workspace — sign-out, org-switch,
 * mode teardown or quit). The
 * widget IPC handlers are BOOT-scoped (registered before the widget window
 * paints). This leaf sits in the boot scope holding the CURRENT workspace's
 * DetectionService: the workspace-scoped service self-publishes here on acquire
 * (compare-and-clear on release), so the boot-scoped `widget:dismiss` handler and
 * the widget state push fiber reach the live workspace without owning its scope —
 * and with no workspace mounted they settle gracefully (idle / no-op), never a throw.
 */
import { Context, Effect, Layer, Option, Stream, SubscriptionRef, type Scope } from 'effect';
import type { DetectionServiceApi } from './service';
import { idleDetectionState, type DetectionState } from './policy';

export interface DetectionBridgeApi {
  /**
   * Workspace-scoped: publish `service` as the current workspace's DetectionService
   * for the enclosing Scope; the finalizer clears it (compare-and-clear so a slow
   * old-workspace teardown that releases AFTER a successor registered does not
   * clobber the live service, mirroring RecordingBridge).
   */
  readonly register: (service: DetectionServiceApi) => Effect.Effect<void, never, Scope.Scope>;
  /** Dismiss the current detection via the mounted workspace; a no-op when none is. */
  readonly dismiss: Effect.Effect<void>;
  /**
   * A single DetectionState stream flattened across workspaces: emits
   * `idleDetectionState` while no workspace is mounted, and the live workspace's state.changes
   * (switching on each workspace swap so a torn-down workspace's
   * detection never leaks into the next). The widget push fiber runs this.
   */
  readonly stateChanges: Stream.Stream<DetectionState>;
}

export class DetectionBridge extends Context.Tag('desktop/detection/DetectionBridge')<
  DetectionBridge,
  DetectionBridgeApi
>() {}

export const DetectionBridgeLive: Layer.Layer<DetectionBridge> = Layer.effect(
  DetectionBridge,
  Effect.gen(function* () {
    const currentRef = yield* SubscriptionRef.make<Option.Option<DetectionServiceApi>>(
      Option.none()
    );

    const api: DetectionBridgeApi = {
      register: service =>
        Effect.acquireRelease(SubscriptionRef.set(currentRef, Option.some(service)), () =>
          SubscriptionRef.update(currentRef, cur =>
            Option.exists(cur, s => s === service) ? Option.none() : cur
          )
        ).pipe(Effect.asVoid),

      dismiss: SubscriptionRef.get(currentRef).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: service => service.dismiss,
          })
        )
      ),

      // switch:true — a workspace swap interrupts the old workspace's inner stream
      // and starts the new one (or the idle stream), so the widget resets to idle
      // when the workspace unmounts and never sees a dead workspace's detection.
      stateChanges: currentRef.changes.pipe(
        Stream.flatMap(
          Option.match({
            onNone: () => Stream.succeed(idleDetectionState),
            onSome: service => service.state.changes,
          }),
          { switch: true }
        )
      ),
    };
    return api;
  })
);
