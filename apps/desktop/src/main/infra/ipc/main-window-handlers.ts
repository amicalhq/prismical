/**
 * Main-window IPC membrane.
 *
 * registerMainWindowHandlers is an Effect that ACQUIRES the ipcMain.handle
 * registrations (finalizer: removeHandler — window close / scope close
 * detaches IPC). Every handler:
 *   1. validates event.sender against the WindowRegistry identity table
 *      (unknown sender → typed rejection + warn log),
 *   2. zod-parses the payload via @prismical/desktop-contracts,
 *   3. bridges into the Effect runtime (ipcMain.handle callbacks are one of
 *      the sanctioned adapter boundaries for running Effects).
 *
 * transport:request runs the full validation path (sender, schema, /apps/v1/me
 * allowlist) then dispatches into the current session's WorkspaceBackend via the
 * boot-scoped WorkspaceTransport — a real fetch to the server with the
 * Bearer id_token + x-active-org-id stamped in MAIN; signed-out settles INTERNAL.
 *
 * Alongside the invoke handlers, one scoped push fiber forwards every
 * AuthService.sessionState change to the main window as the sanitized
 * auth:sessionChanged view.
 */
import { randomUUID } from 'node:crypto';
import { ipcMain, type IpcMainInvokeEvent, session } from 'electron';
import {
  CHANNELS,
  DEFAULT_DEVICE_SETTINGS,
  isAllowedTransportPath,
  parseCollabOpenRequest,
  parseDeviceSettings,
  parseDeviceSettingsPatch,
  parseFloatOpenRequest,
  parseFloatState,
  parseModelRequest,
  parseModelsStateView,
  parseOpenStreamRequest,
  parseOpenWebSessionRequest,
  parsePermissionRequest,
  parseThemeSource,
  parseRecordingE2ECommand,
  parseRecordingControlRequest,
  parseRecordingStateView,
  parseSessionChangedPush,
  parseSignOutRequest,
  parseStartRecordingRequest,
  parseStopRecordingRequest,
  parseSwitchAccountRequest,
  parseSwitchOrgRequest,
  parseAiModelListRequest,
  parseAiProviderKeyRequest,
  parseAiProviderRequest,
  parseChooseAppModeRequest,
  parseResetAppRequest,
  parseTranscriptionByokKeyRequest,
  parseTransportRequest,
  parseUpdateStateView,
  type AiModelListing,
  type AppModeState,
  type AppModeValue,
  type ChooseAppModeResult,
  type CollabOpenResponse,
  type DeviceSettings,
  type EnvDescriptor,
  type OpenStreamResponse,
  type PermissionStatuses,
  type SignInResult,
  type StartRecordingResult,
  type TransportResponse,
  type UpdateCheckResult,
} from '@prismical/desktop-contracts';
import { isValidPrefixedId } from '@prismical/id';
import { Effect, Option, Ref, Runtime, Stream, SubscriptionRef, type Scope } from 'effect';
import { toSessionView } from '../../domains/auth/policy';
import { AuthService } from '../../domains/auth/service';
import { CollabBroker } from '../../domains/collab/service';
import { EventKitBridge } from '../../domains/eventkit/bridge';
import { APP_MODE_KEY } from '../../domains/app-mode/live';
import { AppModeService } from '../../domains/app-mode/service';
import { AI_PROVIDER_KINDS } from '../../domains/ai-provider/instances';
import { aiProviderSecretKey } from '../../domains/ai-provider/secrets';
import { AiProvider } from '../../domains/ai-provider/service';
import { DesktopI18n } from '../../domains/i18n/service';
import { ModelManager } from '../../domains/models/service';
import { RecordingBridge } from '../../domains/recording/bridge';
import {
  systemAudioStatus,
  systemSettingsDeepLink,
} from '../../domains/settings/native-permissions';
import { SettingsService } from '../../domains/settings/service';
import { DEVICE_ID_KEY } from '../../domains/telemetry/service';
import { StreamBroker } from '../../domains/streams/service';
import {
  BYOK_API_KEY_SECRET,
  byokKeyForEndpoint,
  encodeByokCredential,
} from '../../domains/transcriber/byok-credential';
import { WorkspaceTransport } from '../../domains/transport/service';
import { UpdaterService } from '../../domains/updater/service';
import { FloatBridge } from '../../domains/windows/float-bridge';
import { WindowRegistry } from '../../domains/windows/service';
import { SessionLifecycleProbe } from '../../runtime/workspace-lifecycle';
import { AppConfig } from '../config/service';
import { ElectronApp } from '../electron/service';
import { MainLogger } from '../logging/service';
import { NativeOs } from '../native-os/service';
import { OperationalDb, type DbError } from '../operational-db/service';
import { PENDING_PURGE_KEY, encodePendingPurge } from '../pending-reset/service';
import { SECURE_KEY_PREFIX, SecureStore } from '../secure-store/service';
import { SystemPermissions } from '../system-permissions/service';

type HandlerEnv =
  | AppConfig
  | AppModeService
  | ElectronApp
  | AiProvider
  | WindowRegistry
  | FloatBridge
  | StreamBroker
  | CollabBroker
  | WorkspaceTransport
  | AuthService
  | EventKitBridge
  | RecordingBridge
  | DesktopI18n
  | SettingsService
  | SystemPermissions
  | NativeOs
  | UpdaterService
  | ModelManager
  | OperationalDb
  | SecureStore
  | MainLogger
  | SessionLifecycleProbe;

/**
 * The secure-store key holding the BYOK transcription API key. Device-global
 * (not per-sub); the BYOK transcriber lane reads the same
 * key. Never in DeviceSettings, never logged, never returned over IPC.
 */

class SenderRejected extends Error {
  constructor(readonly code: 'UNKNOWN_SENDER') {
    super('UNKNOWN_SENDER');
    this.name = 'SenderRejected';
  }
}

class PayloadRejected extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'INTERNAL') {
    super(code);
    this.name = 'PayloadRejected';
  }
}

/** AuthFlowError reasons map 1:1 onto signInResultSchema codes. */
const FLOW_ERROR_CODES = {
  'not-configured': 'NOT_CONFIGURED',
  'flow-already-pending': 'FLOW_ALREADY_PENDING',
  'browser-launch-failed': 'BROWSER_LAUNCH_FAILED',
} as const;

export const registerMainWindowHandlers: Effect.Effect<void, never, HandlerEnv | Scope.Scope> =
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const appMode = yield* AppModeService;
    const electronApp = yield* ElectronApp;
    const aiProvider = yield* AiProvider;
    const windows = yield* WindowRegistry;
    const broker = yield* StreamBroker;
    const collabBroker = yield* CollabBroker;
    const coreTransport = yield* WorkspaceTransport;
    const auth = yield* AuthService;
    const eventkit = yield* EventKitBridge;
    const recording = yield* RecordingBridge;
    const i18n = yield* DesktopI18n;
    const settings = yield* SettingsService;
    const sysPermissions = yield* SystemPermissions;
    const nativeOs = yield* NativeOs;
    const updater = yield* UpdaterService;
    const models = yield* ModelManager;
    const operationalDb = yield* OperationalDb;
    const secureStore = yield* SecureStore;
    const floatBridge = yield* FloatBridge;
    const log = (yield* MainLogger).scoped('ipc');

    const runtime = yield* Effect.runtime<HandlerEnv>();
    const runPromise = Runtime.runPromise(runtime);

    // E2E-only: a one-shot forced `recording:start` result so the packaged e2e can
    // drive the permission-denied render without a capture device (set via
    // e2e:recording below, consumed once by the start handler under isE2E).
    const startOverrideRef = yield* Ref.make<Option.Option<StartRecordingResult>>(Option.none());

    /**
     * Sender must be an APP window: the registered main window OR the floating
     * note (the float runs the same renderer bundle over the
     * same preload, so the whole main surface is its surface). The sanitized
     * panels (widget/notify) are still rejected here.
     */
    const validateMainSender = (event: IpcMainInvokeEvent): Effect.Effect<void, SenderRejected> =>
      windows
        .identityForWebContents(event.sender.id)
        .pipe(
          Effect.flatMap(identity =>
            Option.isSome(identity) &&
            (identity.value.kind === 'main' || identity.value.kind === 'float-note')
              ? Effect.void
              : log
                  .warn('ipc rejected: unknown sender', { webContentsId: event.sender.id })
                  .pipe(Effect.zipRight(Effect.fail(new SenderRejected('UNKNOWN_SENDER'))))
          )
        );

    const acquireHandle = (
      channel: string,
      handler: (event: IpcMainInvokeEvent, payload?: unknown) => Promise<unknown>
    ) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          ipcMain.handle(channel, handler);
        }),
        () =>
          Effect.sync(() => {
            ipcMain.removeHandler(channel);
          })
      );

    // env:get — the renderer-safe environment descriptor with no core URL.
    // Analytics config crosses to the renderer only OUTSIDE E2E (tests never emit
    // telemetry).
    const envDescriptor: EnvDescriptor = {
      noteWsUrl: config.endpoints.noteWsUrl,
      webAppOrigin: config.endpoints.webAppOrigin,
      analyticsKey: config.isE2E ? null : config.endpoints.analyticsKey,
      // The boot-resolved operating mode: the renderer's posthog-js init keys
      // its policy + config
      // baseline on this, so nothing beacons before the mode is known.
      appMode: appMode.mode,
      analyticsHost: config.isE2E ? null : config.endpoints.analyticsHost,
      platform: config.platform,
      appVersion: config.appVersion,
      applicationLocale: i18n.locale,
      systemLocale: i18n.systemLocale,
    };
    yield* acquireHandle(CHANNELS.envGet, event =>
      runPromise(validateMainSender(event).pipe(Effect.as(envDescriptor)))
    );

    // transport:request — validated unary CloudTransport lane.
    yield* acquireHandle(CHANNELS.transportRequest, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<TransportResponse> => {
            const parsed = parseTransportRequest(payload);
            if (!parsed.success) {
              return log
                .warn('transport:request rejected: invalid payload', { issues: parsed.issues })
                .pipe(Effect.as<TransportResponse>({ error: { code: 'INVALID_REQUEST' } }));
            }
            if (!isAllowedTransportPath(parsed.data.path)) {
              return log
                .warn('transport:request rejected: path not allowed', { path: parsed.data.path })
                .pipe(Effect.as<TransportResponse>({ error: { code: 'PATH_NOT_ALLOWED' } }));
            }
            // Dispatch into the current session's WorkspaceBackend. It
            // stamps Bearer + x-active-org-id in MAIN and maps the exchange onto
            // the envelope; with no live session it settles INTERNAL (never throws).
            return coreTransport.request(parsed.data);
          }),
          Effect.catchAll(rejected =>
            Effect.succeed<TransportResponse>({ error: { code: rejected.code } })
          )
        )
      )
    );

    // transport:openStream — MessagePort streaming lane.
    yield* acquireHandle(CHANNELS.transportOpenStream, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<OpenStreamResponse> => {
            const parsed = parseOpenStreamRequest(payload);
            if (!parsed.success) {
              return log
                .warn('transport:openStream rejected: invalid payload', { issues: parsed.issues })
                .pipe(Effect.as<OpenStreamResponse>({ error: { code: 'INVALID_REQUEST' } }));
            }
            if (!isAllowedTransportPath(parsed.data.path)) {
              return log
                .warn('transport:openStream rejected: path not allowed', { path: parsed.data.path })
                .pipe(Effect.as<OpenStreamResponse>({ error: { code: 'PATH_NOT_ALLOWED' } }));
            }
            const streamId = parsed.data.streamId;
            // Forward the renderer-built Ask request body (main opens the real
            // /apps/v1/me/ask stream and stamps Bearer + org itself).
            return broker.open({ streamId, sender: event.sender, body: parsed.data.body }).pipe(
              Effect.as<OpenStreamResponse>({ ok: true, streamId }),
              Effect.catchTag('StreamError', () =>
                Effect.succeed<OpenStreamResponse>({ error: { code: 'DUPLICATE_STREAM' } })
              )
            );
          }),
          Effect.catchAll(rejected =>
            Effect.succeed<OpenStreamResponse>({ error: { code: rejected.code } })
          )
        )
      )
    );

    // collab:open — the note-body log lane. Same membrane as the
    // stream lane (sender + strict schema), plus a note-id shape check; the
    // broker replies with the port on the per-open channel. Both app windows
    // (main + float-note) may open logs — validateMainSender admits both.
    yield* acquireHandle(CHANNELS.collabOpen, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<CollabOpenResponse> => {
            const parsed = parseCollabOpenRequest(payload);
            if (!parsed.success) {
              return log
                .warn('collab:open rejected: invalid payload', { issues: parsed.issues })
                .pipe(Effect.as<CollabOpenResponse>({ error: { code: 'INVALID_REQUEST' } }));
            }
            if (!isValidPrefixedId('note', parsed.data.noteId)) {
              return log
                .warn('collab:open rejected: not a note id', { noteId: parsed.data.noteId })
                .pipe(Effect.as<CollabOpenResponse>({ error: { code: 'INVALID_REQUEST' } }));
            }
            return collabBroker
              .open({
                openId: parsed.data.openId,
                noteId: parsed.data.noteId,
                sender: event.sender,
              })
              .pipe(
                Effect.as<CollabOpenResponse>({ ok: true }),
                Effect.catchTag('CollabError', error =>
                  Effect.succeed<CollabOpenResponse>({ error: { code: error.code } })
                )
              );
          }),
          Effect.catchAll(rejected =>
            Effect.succeed<CollabOpenResponse>({ error: { code: rejected.code } })
          )
        )
      )
    );

    // auth:getSession — the sanitized session view. toSessionView projects off
    // AuthService.sessionState (tokens live in a private ref inside the auth
    // layer and are structurally absent here).
    yield* acquireHandle(CHANNELS.authGetSession, event =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.zipRight(SubscriptionRef.get(auth.sessionState)),
          Effect.map(toSessionView)
        )
      )
    );

    // auth:signIn — resolves at flow-START (the browser dance is asynchronous);
    // completion travels as an auth:sessionChanged push. Every outcome is a
    // typed SignInResult — the renderer never sees a rejected invoke here.
    yield* acquireHandle(CHANNELS.authSignIn, event =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.zipRight(auth.signIn()),
          Effect.as<SignInResult>({ ok: true }),
          Effect.catchTag('AuthFlowError', error =>
            Effect.succeed<SignInResult>({ ok: false, code: FLOW_ERROR_CODES[error.reason] })
          ),
          Effect.catchAll(rejected =>
            Effect.succeed<SignInResult>({ ok: false, code: rejected.code })
          ),
          Effect.catchAllDefect(defect =>
            log
              .error('auth:signIn defect', { defect: String(defect) })
              .pipe(Effect.as<SignInResult>({ ok: false, code: 'INTERNAL' }))
          )
        )
      )
    );

    // auth:openWebSession — main keeps the native id_token private, exchanges it
    // for Core's short-lived handoff URL, validates that URL, and opens it.
    yield* acquireHandle(CHANNELS.authOpenWebSession, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap(() => {
            const parsed = parseOpenWebSessionRequest(payload);
            if (!parsed.success) {
              return log
                .warn('auth:openWebSession rejected: invalid payload', { issues: parsed.issues })
                .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
            }
            return auth.openWebSession(parsed.data.returnPath, parsed.data.activeOrgId).pipe(
              Effect.tapError(error =>
                log.error('auth:openWebSession failed', {
                  error: error._tag,
                  reason: 'reason' in error ? error.reason : undefined,
                })
              ),
              Effect.mapError(() => new Error('WEB_HANDOFF_FAILED'))
            );
          })
        )
      )
    );

    // auth:getCollabToken — the one sanctioned full-token crossing for the collab
    // WSS bearer. Resolves the current session's guarded id_token via the
    // boot-scoped WorkspaceTransport (the SignedInSession StaleSessionError guard is
    // preserved); signed-out / stale / a failed refresh all fold to null (never a
    // throw). Returns ONLY the id_token string — never the refresh/access token.
    yield* acquireHandle(CHANNELS.authGetCollabToken, event =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.zipRight(coreTransport.collabToken),
          Effect.map(Option.getOrNull)
        )
      )
    );

    // auth:signOut — schema-validated (strict); absent sub ⇒ the active account.
    yield* acquireHandle(CHANNELS.authSignOut, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<void, PayloadRejected | DbError> => {
            // The preload always sends an object; `?? {}` tolerates a bare invoke.
            const parsed = parseSignOutRequest(payload ?? {});
            if (!parsed.success) {
              return log
                .warn('auth:signOut rejected: invalid payload', { issues: parsed.issues })
                .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
            }
            return auth.signOut(parsed.data.sub);
          })
        )
      )
    );

    // auth:switchOrg — re-scope the active account to another org. The
    // orgId is validated in MAIN by setActiveOrg against the account's verified
    // org_users claim; a valid switch mutates sessionState, which BOTH fans out
    // as an auth:sessionChanged push (the renderer's OrgScopedCacheReset drops the
    // org-scoped caches) AND drives the SignedInRuntime swap — identity is
    // (sub, activeOrgId), so the lifecycle tears the old scope down and rebuilds
    // under the new org, and the SignedInSession stale-guard blocks a late fiber
    // from snapping the session back. An org that isn't a
    // membership — or a persist DbError AFTER the in-memory switch already took —
    // is logged and folded to void: the port is fire-and-forget and the renderer
    // only ever observes a real switch through the push.
    yield* acquireHandle(CHANNELS.authSwitchOrg, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<void, PayloadRejected> => {
            const parsed = parseSwitchOrgRequest(payload);
            if (!parsed.success) {
              return log
                .warn('auth:switchOrg rejected: invalid payload', { issues: parsed.issues })
                .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
            }
            return auth.setActiveOrg(parsed.data.orgId).pipe(
              Effect.catchTag('AuthStateError', error =>
                log.warn('auth:switchOrg ignored — org not a membership', {
                  reason: error.reason,
                })
              ),
              Effect.catchTag('DbError', () =>
                log.error('auth:switchOrg could not persist the org pick — switch already applied')
              )
            );
          })
        )
      )
    );

    // auth:switchAccount — make another already-signed-in account active.
    // setActiveAccount validates the sub against the roster; the switch mutates
    // sessionState, re-broadcasting auth:sessionChanged (the renderer resets ALL
    // per-window caches on an account change — a cross-account leak is impossible)
    // and rebuilding the SignedInRuntime for the new account. Unknown sub / a
    // persist DbError fold to void (fire-and-forget).
    yield* acquireHandle(CHANNELS.authSwitchAccount, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<void, PayloadRejected> => {
            const parsed = parseSwitchAccountRequest(payload);
            if (!parsed.success) {
              return log
                .warn('auth:switchAccount rejected: invalid payload', { issues: parsed.issues })
                .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
            }
            return auth.setActiveAccount(parsed.data.sub).pipe(
              Effect.catchTag('AuthStateError', error =>
                log.warn('auth:switchAccount ignored — unknown account', {
                  reason: error.reason,
                })
              ),
              Effect.catchTag('DbError', () =>
                log.error('auth:switchAccount could not persist — switch already applied')
              )
            );
          })
        )
      )
    );

    // recording:start — route the shared record button to the current session's
    // RecordingService. Sender + payload validated (a malformed/foreign
    // sender rejects, like the auth mutations). A valid call folds every business
    // outcome (busy / permission-denied / no-session) to a typed StartRecordingResult
    // the renderer renders — NEVER an unhandled rejection: the mic-only degrade and
    // the two failure states are what the dock surfaces. Under isE2E a forced result
    // (set via e2e:recording) is consumed once, before the bridge, so the packaged
    // e2e can drive the permission-denied render without a capture device.
    yield* acquireHandle(CHANNELS.recordingStart, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<StartRecordingResult, PayloadRejected> => {
            const parsed = parseStartRecordingRequest(payload);
            if (!parsed.success) {
              return log
                .warn('recording:start rejected: invalid payload', { issues: parsed.issues })
                .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
            }
            const forced = config.isE2E
              ? Ref.getAndSet(startOverrideRef, Option.none())
              : Effect.succeed(Option.none<StartRecordingResult>());
            return forced.pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    recording.start({
                      captureMode: parsed.data.captureMode,
                      noteId: parsed.data.noteId ?? null,
                      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
                      ...(parsed.data.autoPause !== undefined
                        ? { autoPause: parsed.data.autoPause }
                        : {}),
                    }),
                  onSome: result => Effect.succeed<StartRecordingResult>(result),
                })
              )
            );
          })
          // Foreign/malformed senders reject the invoke (the security boundary, like
          // the auth mutations); the desktop adapter maps any rejection to a generic
          // failure. Business outcomes above are typed results, never a rejection.
        )
      )
    );

    // recording:stop — gracefully stop + finalize the given recording via the
    // current session (a no-op when signed out or the id is stale). Sender +
    // payload validated like the auth mutations.
    yield* acquireHandle(CHANNELS.recordingStop, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<void, PayloadRejected> => {
            const parsed = parseStopRecordingRequest(payload);
            if (!parsed.success) {
              return log
                .warn('recording:stop rejected: invalid payload', { issues: parsed.issues })
                .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
            }
            return recording.stop(parsed.data.recordingId);
          })
        )
      )
    );

    const registerRecordingControl = (
      channel: string,
      operation: 'pause' | 'resume' | 'claimCompletion'
    ): Effect.Effect<void, never, Scope.Scope> =>
      acquireHandle(channel, (event, payload) =>
        runPromise(
          validateMainSender(event).pipe(
            Effect.flatMap((): Effect.Effect<boolean, PayloadRejected> => {
              const parsed = parseRecordingControlRequest(payload);
              if (!parsed.success) {
                return log
                  .warn(`recording:${operation} rejected: invalid payload`, {
                    issues: parsed.issues,
                  })
                  .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
              }
              return recording[operation](parsed.data.recordingId);
            })
          )
        )
      );

    yield* registerRecordingControl(CHANNELS.recordingClaimCompletion, 'claimCompletion');
    yield* registerRecordingControl(CHANNELS.recordingPause, 'pause');
    yield* registerRecordingControl(CHANNELS.recordingResume, 'resume');

    // settings:get — the current device-local preferences. Re-parsed
    // through the schema belt-and-braces before it crosses (mirrors auth); the ref
    // is always a valid DeviceSettings, so the fallback is unreachable in practice.
    yield* acquireHandle(CHANNELS.settingsGet, event =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.zipRight(settings.get),
          Effect.map((current): DeviceSettings => {
            const parsed = parseDeviceSettings(current);
            return parsed.success ? parsed.data : DEFAULT_DEVICE_SETTINGS;
          })
        )
      )
    );

    // settings:set — merge a partial patch (fire-and-forget). Invalid payload →
    // warn + reject (the shape boundary, like the auth mutations). A persist DbError
    // folds to a logged failure: the renderer's set resolves regardless and the
    // settings:changed push below reflects the truth (the ref is left untouched on
    // failure, so no phantom change is ever observed).
    yield* acquireHandle(CHANNELS.settingsSet, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<void, PayloadRejected> => {
            const parsed = parseDeviceSettingsPatch(payload);
            if (!parsed.success) {
              return log
                .warn('settings:set rejected: invalid payload', { issues: parsed.issues })
                .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
            }
            return settings
              .set(parsed.data)
              .pipe(
                Effect.catchTag('DbError', () =>
                  log.error('settings:set could not persist — change dropped')
                )
              );
          })
        )
      )
    );

    // capability:* — the native action surface. Each handler
    // sender-validates like the mutations above; a foreign/malformed sender rejects
    // the invoke (the desktop adapter maps that to a benign non-result).

    // The current mic + system-audio permission readout. Mic status is
    // Electron's TCC status verbatim; system-audio has no separate TCC readout on
    // this app — it is the pure systemAudioStatus version gate.
    const readPermissions: Effect.Effect<PermissionStatuses> = Effect.gen(function* () {
      const microphone = yield* sysPermissions.microphoneStatus;
      const version = yield* sysPermissions.systemVersion;
      return { microphone, systemAudio: systemAudioStatus(config.platform, version) };
    });

    // capability:checkUpdates — run a user-initiated check and resolve the
    // settled status (metadata + native feed answered, or a download started).
    // Disabled builds (dev/E2E) resolve the explicit 'disabled' status.
    yield* acquireHandle(CHANNELS.capabilityCheckUpdates, event =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.zipRight(updater.checkForUpdates),
          Effect.map((status): UpdateCheckResult => ({ status }))
        )
      )
    );

    // updater:getState / quitInstall / dismissPrompt — the live updater surface
    // The view is main's own derived state; the getState read re-parses
    // through the schema like every crossing.
    yield* acquireHandle(CHANNELS.updaterGetState, event =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.zipRight(SubscriptionRef.get(updater.state)),
          Effect.flatMap(view => {
            const parsed = parseUpdateStateView(view);
            return parsed.success
              ? Effect.succeed(parsed.data)
              : Effect.zipRight(
                  log.error('updater:getState view failed the schema', { issues: parsed.issues }),
                  Effect.fail(new Error('updater state failed validation'))
                );
          })
        )
      )
    );
    yield* acquireHandle(CHANNELS.updaterQuitInstall, event =>
      runPromise(validateMainSender(event).pipe(Effect.zipRight(updater.quitAndInstall)))
    );
    yield* acquireHandle(CHANNELS.updaterDismissPrompt, event =>
      runPromise(validateMainSender(event).pipe(Effect.zipRight(updater.dismissPrompt)))
    );

    // models:* — the local whisper model manager. getState
    // re-parses main's own snapshot through the schema like updater:getState;
    // the verbs are fire-and-forget: a typed refusal (unknown id, already
    // installed, in flight, no disk space) is logged and the models:stateChanged
    // push below tells the renderer the truth — never a rejected invoke for a
    // business outcome. Foreign/malformed senders still reject (the membrane).
    yield* acquireHandle(CHANNELS.modelsGetState, event =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.zipRight(SubscriptionRef.get(models.state)),
          Effect.flatMap(view => {
            const parsed = parseModelsStateView(view);
            return parsed.success
              ? Effect.succeed(parsed.data)
              : Effect.zipRight(
                  log.error('models:getState view failed the schema', { issues: parsed.issues }),
                  Effect.fail(new Error('models state failed validation'))
                );
          })
        )
      )
    );
    const registerModelVerb = (
      channel: string,
      verb: 'download' | 'cancelDownload' | 'delete'
    ): Effect.Effect<void, never, Scope.Scope> =>
      acquireHandle(channel, (event, payload) =>
        runPromise(
          validateMainSender(event).pipe(
            Effect.flatMap((): Effect.Effect<void, PayloadRejected> => {
              const parsed = parseModelRequest(payload);
              if (!parsed.success) {
                return log
                  .warn(`${channel} rejected: invalid payload`, { issues: parsed.issues })
                  .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
              }
              const run =
                verb === 'download'
                  ? models.download(parsed.data.modelId)
                  : verb === 'delete'
                    ? models.delete(parsed.data.modelId)
                    : models.cancel(parsed.data.modelId);
              return run.pipe(
                Effect.catchTag('ModelError', error =>
                  log.warn(`${channel} refused`, {
                    modelId: error.modelId,
                    reason: error.reason,
                    detail: error.detail,
                  })
                ),
                Effect.catchTag('DbError', error =>
                  log.error(`${channel} could not persist`, { op: error.op })
                )
              );
            })
          )
        )
      );
    yield* registerModelVerb(CHANNELS.modelsDownload, 'download');
    yield* registerModelVerb(CHANNELS.modelsCancelDownload, 'cancelDownload');
    yield* registerModelVerb(CHANNELS.modelsDelete, 'delete');

    // capability:exportLogs — reveal the electron-log file in the OS file browser.
    // A reveal defect (edge failure) is logged; the sender rejection propagates.
    yield* acquireHandle(CHANNELS.capabilityExportLogs, event =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.zipRight(
            nativeOs.revealLogs.pipe(
              Effect.catchAllDefect(defect =>
                log.error('capability:exportLogs — reveal failed', { defect: String(defect) })
              )
            )
          )
        )
      )
    );

    // capability:restartApp — apply a persisted interface-language change by
    // relaunching this process. Unlike resetApp below, this deliberately does
    // not touch preferences, IndexedDB, secure storage, or recording recovery.
    yield* acquireHandle(CHANNELS.capabilityRestartApp, event =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.zipRight(log.info('capability:restartApp — relaunching')),
          Effect.zipRight(nativeOs.relaunch)
        )
      )
    );

    // The relaunch arm shared by restartApp / resetApp / chooseAppMode. Graceful in
    // production (NativeOs.relaunch = app.relaunch + app.quit, so the boot scope
    // closes first). Under isE2E a PLAIN quit: Playwright cannot follow
    // app.relaunch(), so the spec observes the exit and relaunches into the kept
    // profile itself — an orphaned relaunch would take the profile's
    // single-instance lock out from under it.
    const relaunch: Effect.Effect<void> = config.isE2E ? electronApp.quit : nativeOs.relaunch;

    /** Sign out every account in the live roster (each drops its refresh secret + rewrites the index). */
    const signOutEveryAccount = SubscriptionRef.get(auth.sessionState).pipe(
      Effect.flatMap(state =>
        Effect.forEach(Object.keys(state.accounts), sub => auth.signOut(sub), { discard: true })
      )
    );

    // capability:getAppModeState — the boot mode + whether one was ever chosen
    // `chosen` is a Ref, not the boot constant: choosing the boot mode
    // persists without a relaunch, and a renderer reload (Cmd+R) re-asks —
    // it must not see the chooser again over a live session.
    const chosenRef = yield* Ref.make(appMode.chosen);
    yield* acquireHandle(CHANNELS.capabilityGetAppModeState, event =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.zipRight(Ref.get(chosenRef)),
          Effect.map((chosen): AppModeState => ({ mode: appMode.mode, chosen }))
        )
      )
    );

    // capability:chooseAppMode — the first-run choice. Persist
    // the raw mode string (AppModeLive matches it verbatim); when it differs
    // from the mode this process booted with, relaunch — the mode is immutable
    // per process. A persist failure rejects the invoke (INTERNAL) so the
    // chooser can say so and stay put, rather than relaunching into a boot that
    // would show it again.
    yield* acquireHandle(CHANNELS.capabilityChooseAppMode, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<ChooseAppModeResult, PayloadRejected> => {
            const parsed = parseChooseAppModeRequest(payload);
            if (!parsed.success) {
              return log
                .warn('capability:chooseAppMode rejected: invalid payload', {
                  issues: parsed.issues,
                })
                .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
            }
            const { mode } = parsed.data;
            // Backstop for the unchosen cloud boot: a roster that somehow got
            // signed in under the chooser must not ride into local mode with
            // its refresh secrets. Nothing else to erase on a first run.
            const severAccounts = mode === 'local' ? signOutEveryAccount : Effect.void;
            return operationalDb.setSetting(APP_MODE_KEY, mode).pipe(
              Effect.catchTag('DbError', error =>
                log
                  .error('capability:chooseAppMode — mode persist failed', { op: error.op })
                  .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INTERNAL'))))
              ),
              Effect.zipRight(severAccounts),
              Effect.zipRight(Ref.set(chosenRef, true)),
              Effect.zipRight(
                mode === appMode.mode
                  ? log
                      .info('capability:chooseAppMode — mode chosen', { mode })
                      .pipe(Effect.as<ChooseAppModeResult>({ relaunch: false }))
                  : log
                      .warn('capability:chooseAppMode — mode chosen; relaunching', { mode })
                      .pipe(
                        Effect.zipRight(relaunch),
                        Effect.as<ChooseAppModeResult>({ relaunch: true })
                      )
              )
            );
          })
        )
      )
    );

    // capability:resetApp — the destructive device reset and, with `{ mode }`,
    // the mode switch. Everything in-process
    // is best-effort and logged; the relaunch always runs (the user asked for
    // it). Two halves:
    //  1. In-process, while the operational store is open: [sign out every
    //     account]* → the known non-auth secrets (BYOK + one slot per AI
    //     provider) → device settings (incl. ai/transcription/telemetryOptOut)
    //     → the EventKit device identity → a REGENERATED telemetry device id →
    //     recording-recovery rows → every renderer storage (the Legend
    //     IndexedDB partition, posthog-js persistence, cookies) → [app:mode]*
    //     → the pending-purge marker.
    //  2. At the next boot, before any product/model/recovery handle exists,
    //     PendingResetLive removes local.db (+WAL/SHM), the cloud-cache dir, the
    //     model weights + local_model rows and the recovery WAVs. Deleting those
    //     here would race the open SQLite handles and the whisper sidecar's
    //     mmapped model (EBUSY on Windows).
    //  (*) switch only: a plain reset keeps the signed-in accounts (their refresh
    //  secrets stay in the secure store) and the running mode.
    // The renderer runs posthog.reset() BEFORE this invoke; the storage wipe
    // below then clears posthog-js persistence, so a reset install is not
    // joinable to the prior identity.
    const clearKnownSecrets = Effect.forEach(
      [BYOK_API_KEY_SECRET, ...AI_PROVIDER_KINDS.map(aiProviderSecretKey)],
      key =>
        secureStore
          .deleteSecret(key)
          .pipe(
            Effect.catchTag('DbError', () => log.error('capability:resetApp — secret clear failed'))
          ),
      { discard: true }
    );
    const purgeMarker = encodePendingPurge({
      v: 1,
      paths: [config.localDbPath, config.cloudCacheDir, config.modelsDir, config.recoveryDir],
      localModels: true,
    });
    // The switch also SWEEPS the whole secure namespace after the sign-outs: a
    // sign-out whose secret delete failed (auth/live.ts tolerates that) or an
    // orphaned refresh-token row from an earlier roster must not ride into the
    // accountless install. The plain reset keeps the accounts, so it only
    // clears the known non-auth slots.
    const sweepSecureNamespace = operationalDb
      .deleteSettingsByPrefix(SECURE_KEY_PREFIX)
      .pipe(
        Effect.catchTag('DbError', () => log.error('capability:resetApp — secure sweep failed'))
      );
    const clearDeviceState = (mode: AppModeValue | undefined): Effect.Effect<void> =>
      (mode === undefined
        ? Effect.void
        : signOutEveryAccount.pipe(Effect.zipRight(sweepSecureNamespace))
      ).pipe(
        Effect.zipRight(clearKnownSecrets),
        Effect.zipRight(
          settings.reset.pipe(
            Effect.catchTag('DbError', () =>
              log.error('capability:resetApp — settings clear failed')
            )
          )
        ),
        Effect.zipRight(
          operationalDb
            .deleteSettingsByPrefix('eventkit:')
            .pipe(
              Effect.catchTag('DbError', () =>
                log.error('capability:resetApp — eventkit identity clear failed')
              )
            )
        ),
        Effect.zipRight(
          operationalDb
            .setSetting(DEVICE_ID_KEY, randomUUID())
            .pipe(
              Effect.catchTag('DbError', () =>
                log.error('capability:resetApp — device id regeneration failed')
              )
            )
        ),
        Effect.zipRight(
          operationalDb.listRecoveryOutbox().pipe(
            Effect.flatMap(rows =>
              Effect.forEach(rows, row => operationalDb.deleteRecoveryOutbox(row.recordingId), {
                discard: true,
              })
            ),
            Effect.catchTag('DbError', () =>
              log.error('capability:resetApp — recovery clear failed')
            )
          )
        ),
        Effect.zipRight(
          Effect.tryPromise({
            // Every storage, not a list: the Legend sync store's IndexedDB
            // partitions, posthog-js localStorage/cookies, and anything a
            // later renderer feature adds. All windows share defaultSession.
            try: () => session.defaultSession.clearStorageData(),
            catch: () => 'storage-clear-failed' as const,
          }).pipe(
            Effect.catchAll(() => log.error('capability:resetApp — renderer storage clear failed'))
          )
        ),
        Effect.zipRight(
          mode === undefined
            ? Effect.void
            : operationalDb
                .setSetting(APP_MODE_KEY, mode)
                .pipe(
                  Effect.catchTag('DbError', () =>
                    log.error('capability:resetApp — mode persist failed', { mode })
                  )
                )
        ),
        Effect.zipRight(
          operationalDb
            .setSetting(PENDING_PURGE_KEY, purgeMarker)
            .pipe(
              Effect.catchTag('DbError', () =>
                log.error('capability:resetApp — purge marker write failed')
              )
            )
        )
      );
    yield* acquireHandle(CHANNELS.capabilityResetApp, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<void, PayloadRejected> => {
            // Absent payload = the plain reset (the old preload sent none).
            const parsed = parseResetAppRequest(payload ?? {});
            if (!parsed.success) {
              return log
                .warn('capability:resetApp rejected: invalid payload', { issues: parsed.issues })
                .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
            }
            const { mode } = parsed.data;
            return clearDeviceState(mode).pipe(
              Effect.zipRight(
                log.warn('capability:resetApp — device state cleared; relaunching', {
                  switchTo: mode ?? null,
                })
              ),
              Effect.zipRight(relaunch)
            );
          })
        )
      )
    );

    // capability:getPermissions — the current mic + system-audio statuses.
    yield* acquireHandle(CHANNELS.capabilityGetPermissions, event =>
      runPromise(validateMainSender(event).pipe(Effect.zipRight(readPermissions)))
    );

    yield* acquireHandle(CHANNELS.capabilityGetAppleCalendarStatus, event =>
      runPromise(validateMainSender(event).pipe(Effect.zipRight(eventkit.getStatus)))
    );
    yield* acquireHandle(CHANNELS.capabilityEnableAppleCalendar, event =>
      runPromise(validateMainSender(event).pipe(Effect.zipRight(eventkit.enable)))
    );
    yield* acquireHandle(CHANNELS.capabilityRefreshAppleCalendar, event =>
      runPromise(validateMainSender(event).pipe(Effect.zipRight(eventkit.refresh)))
    );

    // capability:{set,clear,has}TranscriptionByokKey — the BYOK
    // API key's only home is the secure store. Nothing here logs or echoes the
    // key: a rejected payload logs no issues (they could describe the value),
    // store failures log their tag/op only, and `has` answers a boolean. A key
    // that fails to decrypt reads as absent so the user can simply set it again.
    yield* acquireHandle(CHANNELS.capabilitySetTranscriptionByokKey, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<void, PayloadRejected> => {
            const parsed = parseTranscriptionByokKeyRequest(payload);
            if (!parsed.success) {
              return log
                .warn('capability:setTranscriptionByokKey rejected: invalid payload')
                .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
            }
            return secureStore
              .setSecret(
                BYOK_API_KEY_SECRET,
                encodeByokCredential(parsed.data.baseUrl, parsed.data.key)
              )
              .pipe(
                Effect.catchTags({
                  SecureStoreError: error =>
                    log.error('capability:setTranscriptionByokKey — secure store failed', {
                      reason: error.reason,
                    }),
                  DbError: error =>
                    log.error('capability:setTranscriptionByokKey — could not persist', {
                      op: error.op,
                    }),
                })
              );
          })
        )
      )
    );
    yield* acquireHandle(CHANNELS.capabilityClearTranscriptionByokKey, event =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.zipRight(
            secureStore.deleteSecret(BYOK_API_KEY_SECRET).pipe(
              Effect.catchTag('DbError', error =>
                log.error('capability:clearTranscriptionByokKey — could not persist', {
                  op: error.op,
                })
              )
            )
          )
        )
      )
    );
    yield* acquireHandle(CHANNELS.capabilityHasTranscriptionByokKey, event =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.zipRight(
            secureStore.getSecret(BYOK_API_KEY_SECRET).pipe(
              Effect.flatMap(secret =>
                settings.get.pipe(
                  Effect.map(
                    current =>
                      byokKeyForEndpoint(secret, current.transcription.byokBaseUrl) !== null
                  )
                )
              ),
              Effect.catchTags({
                SecureStoreError: error =>
                  log
                    .warn('capability:hasTranscriptionByokKey — secure store failed', {
                      reason: error.reason,
                    })
                    .pipe(Effect.as(false)),
                DbError: error =>
                  log
                    .error('capability:hasTranscriptionByokKey — read failed', { op: error.op })
                    .pipe(Effect.as(false)),
              })
            )
          )
        )
      )
    );

    // capability:{set,clear,has}AiProviderKey + listAiModels —
    // one secure-store slot per provider kind, under the same discipline as the
    // BYOK transcription key: nothing here logs or echoes a key, a rejected
    // payload logs no issues, store failures log their tag/op only, and `has`
    // answers a boolean. The catalogue is best-effort (the listing carries its
    // own error reason) so the invoke itself never rejects for a network fault.
    yield* acquireHandle(CHANNELS.capabilitySetAiProviderKey, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<void, PayloadRejected> => {
            const parsed = parseAiProviderKeyRequest(payload);
            if (!parsed.success) {
              return log
                .warn('capability:setAiProviderKey rejected: invalid payload')
                .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
            }
            return secureStore
              .setSecret(aiProviderSecretKey(parsed.data.provider), parsed.data.key)
              .pipe(
                // A new key changes what the catalogue and the tool memo would
                // say — drop both so the next read is fresh.
                Effect.zipRight(aiProvider.forget(parsed.data.provider)),
                Effect.catchTags({
                  SecureStoreError: error =>
                    log.error('capability:setAiProviderKey — secure store failed', {
                      provider: parsed.data.provider,
                      reason: error.reason,
                    }),
                  DbError: error =>
                    log.error('capability:setAiProviderKey — could not persist', {
                      provider: parsed.data.provider,
                      op: error.op,
                    }),
                })
              );
          })
        )
      )
    );
    yield* acquireHandle(CHANNELS.capabilityClearAiProviderKey, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<void, PayloadRejected> => {
            const parsed = parseAiProviderRequest(payload);
            if (!parsed.success) {
              return log
                .warn('capability:clearAiProviderKey rejected: invalid payload')
                .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
            }
            return secureStore.deleteSecret(aiProviderSecretKey(parsed.data.provider)).pipe(
              Effect.zipRight(aiProvider.forget(parsed.data.provider)),
              Effect.catchTag('DbError', error =>
                log.error('capability:clearAiProviderKey — could not persist', {
                  provider: parsed.data.provider,
                  op: error.op,
                })
              )
            );
          })
        )
      )
    );
    yield* acquireHandle(CHANNELS.capabilityHasAiProviderKey, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<boolean, PayloadRejected> => {
            const parsed = parseAiProviderRequest(payload);
            if (!parsed.success) {
              return log
                .warn('capability:hasAiProviderKey rejected: invalid payload')
                .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
            }
            return secureStore.getSecret(aiProviderSecretKey(parsed.data.provider)).pipe(
              Effect.map(secret => secret !== null && secret !== ''),
              Effect.catchTags({
                SecureStoreError: error =>
                  log
                    .warn('capability:hasAiProviderKey — secure store failed', {
                      provider: parsed.data.provider,
                      reason: error.reason,
                    })
                    .pipe(Effect.as(false)),
                DbError: error =>
                  log
                    .error('capability:hasAiProviderKey — read failed', {
                      provider: parsed.data.provider,
                      op: error.op,
                    })
                    .pipe(Effect.as(false)),
              })
            );
          })
        )
      )
    );
    yield* acquireHandle(CHANNELS.capabilityListAiModels, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<AiModelListing, PayloadRejected> => {
            const parsed = parseAiModelListRequest(payload);
            if (!parsed.success) {
              return log
                .warn('capability:listAiModels rejected: invalid payload')
                .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
            }
            return aiProvider.listModels(parsed.data.provider, parsed.data.force === true);
          })
        )
      )
    );

    // capability:requestPermission — prompt for a permission (mic → the OS TCC
    // prompt; system-audio has no prompt API here, so it is a no-op re-read), then
    // resolve the refreshed statuses so the renderer reflects the grant.
    yield* acquireHandle(CHANNELS.capabilityRequestPermission, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<PermissionStatuses, PayloadRejected> => {
            const parsed = parsePermissionRequest(payload);
            if (!parsed.success) {
              return log
                .warn('capability:requestPermission rejected: invalid payload', {
                  issues: parsed.issues,
                })
                .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
            }
            const prompt =
              parsed.data.kind === 'microphone'
                ? sysPermissions.requestMicrophoneAccess.pipe(Effect.asVoid)
                : Effect.void;
            return prompt.pipe(Effect.zipRight(readPermissions));
          })
        )
      )
    );

    // capability:openSystemSettings — open the OS privacy pane for a permission
    // A platform/kind with no pane (Linux, or system-audio on Windows) is a
    // logged no-op; an openExternal defect is logged (sender rejection propagates).
    // theme:setSource — mirror the renderer's in-app theme onto nativeTheme so the
    // macOS vibrancy material (and the Windows titleBarOverlay) render in the
    // app's appearance rather than the OS's.
    yield* acquireHandle(CHANNELS.themeSetSource, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<void, PayloadRejected> => {
            const parsed = parseThemeSource(payload);
            if (!parsed.success) {
              return log
                .warn('theme:setSource rejected: invalid payload', { issues: parsed.issues })
                .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
            }
            return windows.setThemeSource(parsed.data);
          })
        )
      )
    );

    yield* acquireHandle(CHANNELS.capabilityOpenSystemSettings, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<void, PayloadRejected> => {
            const parsed = parsePermissionRequest(payload);
            if (!parsed.success) {
              return log
                .warn('capability:openSystemSettings rejected: invalid payload', {
                  issues: parsed.issues,
                })
                .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
            }
            const link = systemSettingsDeepLink(parsed.data.kind, config.platform);
            return link === null
              ? log.info('capability:openSystemSettings — no pane for platform/kind', {
                  kind: parsed.data.kind,
                  platform: config.platform,
                })
              : nativeOs.openExternal(link).pipe(
                  Effect.catchAllDefect(defect =>
                    log.error('capability:openSystemSettings — openExternal failed', {
                      defect: String(defect),
                    })
                  )
                );
          })
        )
      )
    );

    // recording:stateChanged — scoped push fiber: the bridge's cross-session
    // RecordingState stream fans out to the main window as the sanitized view.
    // Re-parsing through the strict schema is belt-and-braces (mirrors auth): a
    // token-shaped field would fail the parse and the push is dropped loudly rather
    // than crossing the membrane (recording state is ids + transcript text only).
    yield* Effect.forkScoped(
      Stream.runForEach(recording.stateChanges, state => {
        const parsed = parseRecordingStateView(state);
        const push = parsed.success
          ? windows.sendToAppWindows(CHANNELS.recordingStateChanged, parsed.data)
          : log.error('recording:stateChanged push dropped: view failed the strict schema', {
              issues: parsed.issues,
            });
        // Like the auth push: a webContents.send racing window destruction throws a
        // DEFECT — logged so the fan-out fiber survives for the process lifetime.
        return push.pipe(
          Effect.catchAllDefect(defect =>
            log.error('recording:stateChanged push failed — fiber continues', {
              defect: String(defect),
            })
          )
        );
      })
    );

    // auth:sessionChanged — scoped push fiber: every sessionState change fans
    // out to the main window as the sanitized view. Re-parsing through the
    // strict schema is belt-and-braces: a token-shaped field fails the
    // parse and the push is dropped loudly instead of crossing the membrane.
    // Released with the layer scope like the handlers above.
    yield* Effect.forkScoped(
      Stream.runForEach(auth.sessionState.changes, state => {
        const parsed = parseSessionChangedPush(toSessionView(state));
        const push = parsed.success
          ? windows.sendToAppWindows(CHANNELS.authSessionChanged, parsed.data)
          : log.error('auth:sessionChanged push dropped: view failed the strict schema', {
              issues: parsed.issues,
            });
        // webContents.send racing window destruction throws — a
        // defect here would kill this fan-out fiber for the process lifetime
        // (every later renderer permanently stale once a window reopens).
        // One dropped push is logged; the fiber lives on. Interrupts (scope
        // close) pass through untouched — catchAllDefect never sees them.
        return push.pipe(
          Effect.catchAllDefect(defect =>
            log.error('auth:sessionChanged push failed — fiber continues', {
              defect: String(defect),
            })
          )
        );
      })
    );

    // settings:changed — scoped push fiber: every SettingsService.settings
    // change fans out to the main window. SubscriptionRef.changes replays the CURRENT
    // settings immediately, so the renderer's replay buffer gets an initial snapshot
    // even before the first mutation. Re-parsing through the schema is belt-and-braces
    // (mirrors recording/auth); a value that somehow failed is dropped loudly rather
    // than crossing, and a send racing window destruction throws a DEFECT that is
    // logged so the fan-out fiber survives for the process lifetime.
    yield* Effect.forkScoped(
      Stream.runForEach(settings.settings.changes, current => {
        const parsed = parseDeviceSettings(current);
        const push = parsed.success
          ? windows.sendToAppWindows(CHANNELS.settingsChanged, parsed.data)
          : log.error('settings:changed push dropped: view failed the schema', {
              issues: parsed.issues,
            });
        return push.pipe(
          Effect.catchAllDefect(defect =>
            log.error('settings:changed push failed — fiber continues', {
              defect: String(defect),
            })
          )
        );
      })
    );

    // updater:stateChanged — scoped push fiber: every updater-view change
    // fans out to the main window (same replay/parse/defect posture as settings).
    yield* Effect.forkScoped(
      Stream.runForEach(updater.state.changes, current => {
        const parsed = parseUpdateStateView(current);
        const push = parsed.success
          ? windows.sendToAppWindows(CHANNELS.updaterStateChanged, parsed.data)
          : log.error('updater:stateChanged push dropped: view failed the schema', {
              issues: parsed.issues,
            });
        return push.pipe(
          Effect.catchAllDefect(defect =>
            log.error('updater:stateChanged push failed — fiber continues', {
              defect: String(defect),
            })
          )
        );
      })
    );

    // models:stateChanged — scoped push fiber: every model-manager snapshot
    // change (install, delete, throttled progress) fans out to the app windows.
    // Same replay/parse/defect posture as settings: SubscriptionRef.changes
    // replays the current snapshot on registration; a value that fails the
    // schema is dropped loudly; a send racing window destruction is logged.
    yield* Effect.forkScoped(
      Stream.runForEach(models.state.changes, current => {
        const parsed = parseModelsStateView(current);
        const push = parsed.success
          ? windows.sendToAppWindows(CHANNELS.modelsStateChanged, parsed.data)
          : log.error('models:stateChanged push dropped: view failed the schema', {
              issues: parsed.issues,
            });
        return push.pipe(
          Effect.catchAllDefect(defect =>
            log.error('models:stateChanged push failed — fiber continues', {
              defect: String(defect),
            })
          )
        );
      })
    );

    // float:* — the floating note verbs. Both app senders (main
    // + float-note) may drive them; the FloatBridge owns the slot semantics.
    yield* acquireHandle(CHANNELS.floatOpen, (event, payload) =>
      runPromise(
        validateMainSender(event).pipe(
          Effect.flatMap((): Effect.Effect<void, PayloadRejected> => {
            const parsed = parseFloatOpenRequest(payload);
            if (!parsed.success) {
              return log
                .warn('float:open rejected: invalid payload', { issues: parsed.issues })
                .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
            }
            return floatBridge.open(parsed.data.noteId).pipe(Effect.asVoid);
          })
        )
      )
    );
    yield* acquireHandle(CHANNELS.floatCollapse, event =>
      runPromise(validateMainSender(event).pipe(Effect.zipRight(floatBridge.collapse)))
    );
    yield* acquireHandle(CHANNELS.floatDockBack, event =>
      runPromise(validateMainSender(event).pipe(Effect.zipRight(floatBridge.dockBack)))
    );

    // Sign-out teardown for the float: with no active account the float window
    // renders NOTHING (the gate is main-window chrome) — an invisible focusable
    // always-on-top window would eat clicks with no recovery path, and its live
    // IndexedDB connection would block the sign-out data purge. Close it and
    // clear the slot the moment the session loses its active account.
    yield* Effect.forkScoped(
      Stream.runForEach(
        auth.sessionState.changes.pipe(
          Stream.map(state => {
            const view = toSessionView(state);
            return (
              view.activeSub !== undefined &&
              view.accounts.some(account => account.sub === view.activeSub)
            );
          }),
          Stream.changes,
          Stream.filter(hasActiveAccount => !hasActiveAccount)
        ),
        () =>
          floatBridge.reset.pipe(
            Effect.catchAllDefect(defect =>
              log.error('float sign-out reset failed', { defect: String(defect) })
            )
          )
      )
    );

    // float:state — scoped push fiber: the slot state fans to the app windows
    // (pop-out button state; the float chrome itself). Same parse/defect posture
    // as every push lane.
    yield* Effect.forkScoped(
      Stream.runForEach(floatBridge.state.changes, current => {
        const parsed = parseFloatState(current);
        const push = parsed.success
          ? windows.sendToAppWindows(CHANNELS.floatStateChanged, parsed.data)
          : log.error('float:state push dropped: view failed the schema', {
              issues: parsed.issues,
            });
        return push.pipe(
          Effect.catchAllDefect(defect =>
            log.error('float:state push failed — fiber continues', { defect: String(defect) })
          )
        );
      })
    );

    // e2e:* — test-only observability, PRISMICAL_E2E builds only.
    if (config.isE2E) {
      const sessionProbe = yield* SessionLifecycleProbe;
      yield* acquireHandle(CHANNELS.e2eStreamStats, event =>
        runPromise(validateMainSender(event).pipe(Effect.zipRight(broker.stats)))
      );
      // The pending OAuth attempt's state param (never the verifier) — the auth
      // e2e specs mint their fake deep-link callbacks from it.
      yield* acquireHandle(CHANNELS.e2eAuthPendingState, event =>
        runPromise(validateMainSender(event).pipe(Effect.zipRight(auth.pendingAttemptState)))
      );
      // Public OAuth request values only (challenge + state); the verifier remains in AuthService.
      yield* acquireHandle(CHANNELS.e2eAuthAuthorizeUrl, event =>
        runPromise(validateMainSender(event).pipe(Effect.zipRight(auth.pendingAttemptAuthorizeUrl)))
      );
      // SignedInRuntime lifecycle counters + pinned identity (the
      // only way an e2e can observe "exactly one runtime per valid callback" —
      // acquisition failure is silent to the gate by design).
      yield* acquireHandle(CHANNELS.e2eSessionProbe, event =>
        runPromise(validateMainSender(event).pipe(Effect.zipRight(sessionProbe.snapshot)))
      );
      // e2e:recording — the packaged recording e2e driver: push a fabricated
      // RecordingState to the window, or arm the next recording:start result, so the
      // transcript render + permission-denied paths exercise without a capture device
      // or the cloud. Sender + payload validated like every handler.
      yield* acquireHandle(CHANNELS.e2eRecording, (event, payload) =>
        runPromise(
          validateMainSender(event).pipe(
            Effect.flatMap((): Effect.Effect<void, PayloadRejected> => {
              const parsed = parseRecordingE2ECommand(payload);
              if (!parsed.success) {
                return log
                  .warn('e2e:recording rejected: invalid payload', { issues: parsed.issues })
                  .pipe(Effect.zipRight(Effect.fail(new PayloadRejected('INVALID_REQUEST'))));
              }
              return parsed.data.kind === 'push'
                ? windows
                    .sendToMainWindow(CHANNELS.recordingStateChanged, parsed.data.view)
                    .pipe(Effect.asVoid)
                : Ref.set(startOverrideRef, Option.some(parsed.data.result));
            })
          )
        )
      );
    }

    yield* log.info('main-window ipc handlers registered', { e2eChannels: config.isE2E });
  });
