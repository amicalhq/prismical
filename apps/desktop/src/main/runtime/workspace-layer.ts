/**
 * The workspace layer is the service graph that exists exactly while one workspace
 * is mounted. In cloud mode that is one (account, org) identity — "absent
 * until auth; rebuilt atomically on account/org switch", exactly as before.
 * In local mode it is the accountless on-device workspace: the ProductDb
 * (local.db) plus the LocalBackend serving /apps/v1/me/* from it. Built
 * by runtime/workspace-lifecycle.ts into a per-workspace Scope; the old scope
 * is fully closed before a successor is built.
 *
 * Mode discipline: everything account-free composes in
 * `sharedWorkspaceServices` against the abstract WorkspaceBackend tag —
 * Capture, MicActivity, PermissionService, RecordingService, RecoveryDrain
 * and DetectionService never see SignedInSession or a pinned identity, BY
 * type. Only the backend choice and EventKit (calendar is cloud-only)
 * live in a mode branch.
 *
 * Deliberately NOT here: refresh machinery (single-flight, scheduler,
 * powerMonitor/focus triggers, restore-on-boot). All of it lives in the
 * boot-scoped AuthService — restart-restore must refresh before any cloud
 * workspace exists. The cloud branch only PINS an identity and borrows tokens
 * through the guard below.
 */
import { Context, Data, Effect, Layer, SubscriptionRef } from 'effect';
import { AppModeService } from '../domains/app-mode/service';
import type { AiProvider } from '../domains/ai-provider/service';
import { AuthService, type AuthStateError, type RefreshError } from '../domains/auth/service';
import { NoteBodyStoreLive } from '../domains/collab/store-live';
import { CollabBridge, NoteBodyStore } from '../domains/collab/store';
import { DetectionBridge } from '../domains/detection/bridge';
import { DetectionServiceLive } from '../domains/detection/live';
import { DetectionService } from '../domains/detection/service';
import { EventKitBridge } from '../domains/eventkit/bridge';
import { EventKitServiceLive } from '../domains/eventkit/live';
import { EventKitService } from '../domains/eventkit/service';
import { DesktopI18n } from '../domains/i18n/service';
import { LocalBackendLive } from '../domains/local-backend/live';
import { ModelManager } from '../domains/models/service';
import { RecordingBridge } from '../domains/recording/bridge';
import { CaptureLive } from '../domains/recording/capture/live';
import { RecordingServiceLive } from '../domains/recording/live';
import { PermissionServiceLive } from '../domains/recording/permission/live';
import { RecoveryDrainLive } from '../domains/recording/recovery-drain';
import { RecordingService } from '../domains/recording/service';
import { RecordingStoreLive } from '../domains/recording/store-live';
import { SettingsService } from '../domains/settings/service';
import { ByokTranscriberLive } from '../domains/transcriber/byok';
import { CloudTranscriberLive } from '../domains/transcriber/cloud';
import { TranscriberLive } from '../domains/transcriber/live';
import { LocalWhisperLive } from '../domains/transcriber/local';
import { CloudBackendLive } from '../domains/transport/live';
import { WorkspaceBackend, WorkspaceTransport } from '../domains/transport/service';
import { AppConfig } from '../infra/config/service';
import { MainLogger } from '../infra/logging/service';
import { MicActivityLive } from '../infra/mic-detector/live';
import { MicActivity } from '../infra/mic-detector/service';
import { OperationalDb } from '../infra/operational-db/service';
import { makeProductDbLayer } from '../infra/product-db/live';
import { ProductDb, type ProductDbError } from '../infra/product-db/service';
import { SecureStore } from '../infra/secure-store/service';
import { SystemPermissionsLive } from '../infra/system-permissions/live';
import { WhisperEngine } from '../infra/whisper/service';
import { WorkspaceIdentity } from './workspace-identity';

/**
 * Identity + display claims captured from the AuthState snapshot that
 * triggered acquisition. Never contains token values — only the accessor
 * below can produce one, and only while the pin still matches.
 */
export interface PinnedSession {
  readonly sub: string;
  readonly email: string;
  readonly name?: string;
  readonly activeOrgId?: string;
}

/**
 * Which workspace should be mounted — what the workspace lifecycle reconciles
 * on. The session lifecycle becomes a workspace lifecycle that reconciles on
 * (mode, identity). Cloud carries the pinned identity; local
 * is identity-free by construction.
 */
export type DesiredWorkspace =
  | { readonly mode: 'cloud'; readonly pinned: PinnedSession }
  | { readonly mode: 'local' };

/**
 * Everything a workspace layer builds under — the boot-scoped ambient:
 * AuthService feeds the cloud identity
 * guard; the cloud backend pulls AppConfig (coreApiUrl) and self-publishes
 * into the boot-scoped WorkspaceTransport; the RecordingService shares the
 * boot OperationalDb for the recovery outbox and self-publishes into the
 * boot-scoped RecordingBridge (as DetectionService does into DetectionBridge,
 * EventKit into EventKitBridge, the NoteBodyStore into CollabBridge);
 * DesktopI18n supplies the immutable startup locale for recording fallback
 * titles. For the transcription engine, SettingsService (the engine preference,
 * read per recording start / drain pass) and AppModeService (local mode
 * coerces the cloud default) feed engine resolution; SecureStore (the BYOK
 * key), ModelManager (installed weights) and WhisperEngine (the boot-scoped
 * whisper.cpp worker host) are what the BYOK / local whisper lanes build under.
 */
export type WorkspaceLayerEnv =
  | AuthService
  | MainLogger
  | AppConfig
  | WorkspaceTransport
  | OperationalDb
  | RecordingBridge
  | DetectionBridge
  | EventKitBridge
  | CollabBridge
  | DesktopI18n
  | SettingsService
  | SecureStore
  | AppModeService
  | ModelManager
  | WhisperEngine
  | AiProvider;

/**
 * The pinned identity no longer matches the active (account, org): this
 * session is a zombie awaiting teardown by the lifecycle loop. Failing typed
 * here is the structural guarantee that a late refresh or stale fiber can
 * never act as a dropped or switched account.
 */
export class StaleSessionError extends Data.TaggedError('StaleSessionError')<{
  readonly pinnedSub: string;
  readonly reason: 'account-dropped' | 'account-switched' | 'org-switched';
}> {}

export interface SignedInSessionApi {
  readonly pinned: PinnedSession;
  /**
   * A currently-valid id_token for the PINNED account. Delegates to
   * AuthService.getIdToken(pinned.sub) but fails typed the moment the pinned
   * identity is no longer the active one — the org check is deliberately as
   * strict as the account check, since an org switch also swaps the runtime.
   */
  readonly idToken: Effect.Effect<string, StaleSessionError | RefreshError | AuthStateError>;
}

export class SignedInSession extends Context.Tag('desktop/SignedInSession')<
  SignedInSession,
  SignedInSessionApi
>() {}

/** Log prefix only — subs are identifiers but full values stay out of logs. */
const subPrefix = (sub: string): string => sub.slice(0, 6) + '…';

/**
 * The cloud identity for one pinned (account, org). Layer.scoped +
 * acquireRelease so teardown is observable (tests assert the release ran, not
 * hope it did). Cloud-branch only — local mode never has one (its synthetic
 * workspace identity is a renderer concern).
 */
const makeSignedInSessionLayer = (
  pinned: PinnedSession
): Layer.Layer<SignedInSession, never, AuthService | MainLogger> =>
  Layer.scoped(
    SignedInSession,
    Effect.gen(function* () {
      const auth = yield* AuthService;
      const log = (yield* MainLogger).scoped('session');
      yield* Effect.acquireRelease(
        log.info('signed-in scope acquired', {
          sub: subPrefix(pinned.sub),
          org: pinned.activeOrgId,
        }),
        () =>
          log.info('signed-in scope released', {
            sub: subPrefix(pinned.sub),
            org: pinned.activeOrgId,
          })
      );

      const guard: Effect.Effect<void, StaleSessionError> = SubscriptionRef.get(
        auth.sessionState
      ).pipe(
        Effect.flatMap(state => {
          const account = state.accounts[pinned.sub];
          if (account === undefined) {
            return Effect.fail(
              new StaleSessionError({ pinnedSub: pinned.sub, reason: 'account-dropped' })
            );
          }
          if (state.activeSub !== pinned.sub) {
            return Effect.fail(
              new StaleSessionError({ pinnedSub: pinned.sub, reason: 'account-switched' })
            );
          }
          if (account.activeOrgId !== pinned.activeOrgId) {
            return Effect.fail(
              new StaleSessionError({ pinnedSub: pinned.sub, reason: 'org-switched' })
            );
          }
          return Effect.void;
        })
      );

      const api: SignedInSessionApi = {
        pinned,
        // A refresh can outlast an account/org switch. Check again after the
        // await so callers cannot receive a token from a stale workspace.
        idToken: guard.pipe(Effect.zipRight(auth.getIdToken(pinned.sub)), Effect.zipLeft(guard)),
      };
      return api;
    })
  );

/**
 * The mode-agnostic workspace services are account-free by type — everything
 * composes against the abstract
 * WorkspaceBackend and this function never sees a pinned identity. The
 * per-service composition notes are unchanged from the signed-in era:
 *
 * - MicActivity: one detector child and one replay-latest feed per
 *   workspace. Detection and recording consume this same layer instance.
 * - RecordingService: every recording fiber (and its native capture
 *   child) is interrupted and its outbox row parked when the workspace closes
 *   (sign-out / org-switch / quit). It reads the SAME backend the branch
 *   provides, provides its own CaptureLive (needs only MainLogger, from
 *   boot), and shares the boot OperationalDb for the recovery outbox. The
 *   PermissionService gates each start (mic TCC + system-audio ≥14.2
 *   degrade) through the SystemPermissions electron edge; OS-global +
 *   stateless, so mounting it per-workspace is harmless.
 * - RecoveryDrain: forks on acquire, resolving recordings a prior
 *   crash/logout/quit interrupted. Reads the SAME backend + RecordingService
 *   (referenced again → memoized) so it skips the in-flight recording.
 *   Provides no service — merged for its acquire fork.
 * - DetectionService: consumes the shared MicActivity feed (which
 *   owns and reaps the detector child) and the SAME RecordingService to
 *   suppress detection while a recording is active. It NEVER starts a
 *   recording — it publishes DetectionService.state for the widget.
 * - RecordingStore: recording + transcript-segment persistence over
 *   the branch's ProductDb (which is why this block now requires ProductDb).
 *   RecordingService and the drain reference the one const → memoized, so
 *   both write through the SAME store.
 * - Transcriber: the one seam both chunk producers transcribe through,
 *   dispatching per frozen engine to the cloud lane (WAV-encode + the
 *   branch's WorkspaceBackend upload, byte-identical to before), the local
 *   lane (LocalWhisperLive — whisper.cpp through the boot-scoped WhisperEngine,
 *   weights from the boot-scoped ModelManager, vocabulary from the branch's
 *   ProductDb) or the BYOK lane (ByokTranscriberLive — the key from the boot
 *   SecureStore). One const → memoized, so the live path and the drain share
 *   the lanes (and the local lane's per-recording resampler/prompt state).
 */
const sharedWorkspaceServices = (): Layer.Layer<
  RecordingService | DetectionService | MicActivity,
  never,
  | WorkspaceBackend
  | ProductDb
  | MainLogger
  | AppConfig
  | OperationalDb
  | RecordingBridge
  | DetectionBridge
  | DesktopI18n
  | SettingsService
  | AppModeService
  | SecureStore
  | ModelManager
  | WhisperEngine
  | WorkspaceIdentity
> => {
  const micActivity = MicActivityLive;
  const recordingStore = RecordingStoreLive;
  const transcriber = TranscriberLive.pipe(
    Layer.provide(CloudTranscriberLive),
    Layer.provide(LocalWhisperLive),
    Layer.provide(ByokTranscriberLive)
  );
  const recording = RecordingServiceLive.pipe(
    Layer.provide(micActivity),
    Layer.provide(recordingStore),
    Layer.provide(transcriber),
    Layer.provide(CaptureLive),
    Layer.provide(PermissionServiceLive.pipe(Layer.provide(SystemPermissionsLive)))
  );
  const drain = RecoveryDrainLive.pipe(
    Layer.provide(recording),
    Layer.provide(recordingStore),
    Layer.provide(transcriber)
  );
  const detection = DetectionServiceLive.pipe(Layer.provide(recording), Layer.provide(micActivity));
  return Layer.mergeAll(micActivity, recording, detection, drain);
};

/**
 * The cloud workspace for one pinned identity — the former makeSignedInLayer.
 * The branch supplies exactly what is cloud-specific: the SignedInSession
 * identity guard, the CloudBackend (today's CoreClient — it shares the
 * workspace scope, reads identity/tokens exclusively through SignedInSession,
 * and self-publishes into the boot-scoped WorkspaceTransport for the
 * workspace's lifetime), EventKit (calendar is cloud-only), and
 * the per-(sub, org) cloud-cache ProductDb with the NoteBodyStore over it, so
 * the note-body log lane persists offline in cloud mode too. The cache open
 * makes THIS branch's acquire fallible now (mirroring local): an open failure
 * tears the workspace down and the lifecycle rolls back + retries.
 * `session`/`backend`/`cache` are single consts referenced multiple times →
 * Effect memoizes them, so every consumer reads the SAME guarded instances.
 */
export const makeCloudWorkspaceLayer = (
  pinned: PinnedSession
): Layer.Layer<
  | SignedInSession
  | WorkspaceBackend
  | ProductDb
  | NoteBodyStore
  | RecordingService
  | DetectionService
  | EventKitService
  | MicActivity,
  ProductDbError,
  WorkspaceLayerEnv
> => {
  const session = makeSignedInSessionLayer(pinned);
  const backend = CloudBackendLive.pipe(Layer.provide(session));
  const cache = makeProductDbLayer({
    kind: 'cloud-cache',
    sub: pinned.sub,
    ...(pinned.activeOrgId === undefined ? {} : { orgId: pinned.activeOrgId }),
  });
  const noteBody = NoteBodyStoreLive.pipe(Layer.provide(cache));
  const identity = Layer.succeed(WorkspaceIdentity, {
    mode: 'cloud',
    sub: pinned.sub,
    orgId: pinned.activeOrgId ?? null,
  });
  const shared = sharedWorkspaceServices().pipe(
    Layer.provide(backend),
    Layer.provide(cache),
    Layer.provide(identity)
  );
  const eventkit = EventKitServiceLive.pipe(Layer.provide(backend), Layer.provide(session));
  return Layer.mergeAll(session, backend, cache, noteBody, shared, eventkit);
};

/**
 * The local workspace is the accountless on-device runtime. The branch
 * supplies exactly what is local-specific — the ProductDb (local.db, whose
 * open is the one FALLIBLE acquire in the workspace graph: an open/migration
 * failure fails the whole build and the lifecycle rolls it back and retries)
 * and the LocalBackend serving /apps/v1/me/* from it — then mounts the SAME
 * sharedWorkspaceServices block as cloud against that backend, plus the
 * NoteBodyStore over the same store (it self-publishes into the
 * boot-scoped CollabBridge). No SignedInSession, no EventKit (calendar is
 * cloud-only). `productDb`/`backend` are single constants referenced
 * multiple times → Effect memoizes them, so every consumer reads the SAME
 * instances (and ProductDb rides the ROut for tests and the note-body/recording
 * stores). The scoped log pair keeps the lifecycle observable (e2e greps the
 * exact lines).
 */
export const makeLocalWorkspaceLayer = (): Layer.Layer<
  ProductDb | WorkspaceBackend | NoteBodyStore | RecordingService | DetectionService | MicActivity,
  ProductDbError,
  WorkspaceLayerEnv
> => {
  const productDb = makeProductDbLayer({ kind: 'local' });
  const backend = LocalBackendLive.pipe(Layer.provide(productDb));
  const noteBody = NoteBodyStoreLive.pipe(Layer.provide(productDb));
  const shared = sharedWorkspaceServices().pipe(
    Layer.provide(backend),
    Layer.provide(productDb),
    Layer.provide(Layer.succeed(WorkspaceIdentity, { mode: 'local' }))
  );
  const scopeLog = Layer.scopedDiscard(
    Effect.gen(function* () {
      const log = (yield* MainLogger).scoped('workspace');
      yield* Effect.acquireRelease(log.info('local workspace scope acquired'), () =>
        log.info('local workspace scope released')
      );
    })
  );
  return Layer.mergeAll(productDb, backend, noteBody, shared, scopeLog);
};

/**
 * The workspace layer for one desired workspace. The declared ROut is
 * the branches' common floor — the lifecycle only builds/closes the scope and
 * never reads services out of it; tests that reach into branch services use
 * makeCloudWorkspaceLayer/makeLocalWorkspaceLayer's full typing. E is the
 * branches' union: BOTH branches open a ProductDb now (local.db / the cloud
 * cache), so either acquire can fail — the lifecycle Effect.exits the
 * build and rolls back either way.
 */
export const makeWorkspaceLayer = (
  desired: DesiredWorkspace
): Layer.Layer<never, ProductDbError, WorkspaceLayerEnv> =>
  desired.mode === 'cloud' ? makeCloudWorkspaceLayer(desired.pinned) : makeLocalWorkspaceLayer();
