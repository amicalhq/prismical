/**
 * Main-window IPC contract v1.
 *
 * Every channel the main window's preload may invoke, plus every main→renderer
 * push channel, is enumerated here with a zod schema. The main process rejects
 * anything not in this file; the preload exposes nothing generic (no on/off,
 * no channel passthrough).
 *
 * The auth:* channels are live end to end: main-process handlers bridge into
 * the AuthService, and the preload exposes the `auth` surface with a
 * session-changed replay buffer.
 */
import { z } from 'zod';

/** Complete interface locales allowed across every desktop IPC membrane. */
export const applicationLocaleSchema = z.enum(['en', 'de', 'es', 'ja', 'zh-TW']);
export type ApplicationLocale = z.infer<typeof applicationLocaleSchema>;

/** Device preference wire value; the empty string means "follow the OS". */
export const applicationLocalePreferenceSchema = z.union([z.literal(''), applicationLocaleSchema]);
export type ApplicationLocalePreference = z.infer<typeof applicationLocalePreferenceSchema>;

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

export const CHANNELS = {
  /** invoke → EnvDescriptor. The environment injection (never service URLs). */
  envGet: 'env:get',
  /** invoke → TransportResponse. Unary CloudTransport lane. */
  transportRequest: 'transport:request',
  /** invoke → OpenStreamResponse; a MessagePort follows on the per-stream channel. */
  transportOpenStream: 'transport:openStream',
  /** invoke → CollabOpenResponse; a MessagePort follows on the per-open channel. */
  collabOpen: 'collab:open',
  /** push main→renderer: navigation command {path}. */
  navPush: 'nav:push',
  /**
   * Floating note — the dock's expanded mode. The float
   * window loads the SAME renderer bundle (index.html#/float) with the SAME
   * main preload, so these verbs live on the main-window surface and both the
   * main and float-note senders may invoke them.
   */
  /** invoke(FloatOpenRequest) → void: open/focus the float on a note (null = the slot). */
  floatOpen: 'float:open',
  /** invoke → void: collapse the float back to the pill (KEEPS the slot). */
  floatCollapse: 'float:collapse',
  /** invoke → void: dock the note back into the app (CLEARS the slot, focuses main). */
  floatDockBack: 'float:dockBack',
  /** push main→app windows: the float slot state {open, noteId}. */
  floatStateChanged: 'float:state',
  /** invoke → StreamStats. Registered ONLY when PRISMICAL_E2E=1 (test-only). */
  e2eStreamStats: 'e2e:streamStats',
  /**
   * invoke → string | null. The pending OAuth attempt's `state` param (null
   * when no attempt is parked) — the auth e2e specs construct their fake
   * callback URLs from it. Registered ONLY when PRISMICAL_E2E=1 (test-only);
   * the PKCE verifier never crosses any channel.
   */
  e2eAuthPendingState: 'e2e:authPendingState',
  /**
   * invoke → string | null. The public PKCE authorize URL for the parked
   * attempt. Registered ONLY when PRISMICAL_E2E=1 so an external smoke browser
   * can complete the real login while Electron keeps OS protocol registration
   * disabled. Contains challenge + state, never the verifier or a token.
   */
  e2eAuthAuthorizeUrl: 'e2e:authAuthorizeUrl',
  /**
   * invoke → SessionProbe. Workspace lifecycle counters + the pinned cloud
   * identity (sub/org only — never tokens; null for a local workspace) so the
   * auth e2e specs can assert "exactly one runtime per valid callback" against
   * the REAL app. Registered ONLY when PRISMICAL_E2E=1 (test-only).
   */
  e2eSessionProbe: 'e2e:sessionProbe',
  /** invoke → SessionView. Sanitized session view (no token fields, ever). */
  authGetSession: 'auth:getSession',
  /** invoke → SignInResult. Starts main-owned PKCE via the system browser. */
  authSignIn: 'auth:signIn',
  /** invoke(OpenWebSessionRequest) → void. Native identity → browser handoff. */
  authOpenWebSession: 'auth:openWebSession',
  /** invoke(SignOutRequest) → void. Revoke + interrupt SignedInRuntime. */
  authSignOut: 'auth:signOut',
  /**
   * invoke(SwitchOrgRequest) → void. Re-scope the ACTIVE account to another
   * org: validated in MAIN against the verified org_users claim, then the
   * session mutates + re-broadcasts auth:sessionChanged (rebuilding the
   * SignedInRuntime under the new org and resetting the per-window org caches).
   * Fire-and-forget: the renderer observes the switch via the push.
   */
  authSwitchOrg: 'auth:switchOrg',
  /**
   * invoke(SwitchAccountRequest) → void. Make another already-signed-in account
   * active: validated in MAIN against the signed-in roster, then the
   * session mutates + re-broadcasts auth:sessionChanged (rebuilding the
   * SignedInRuntime for the new account and resetting ALL per-window caches).
   */
  authSwitchAccount: 'auth:switchAccount',
  /**
   * invoke → string | null. The CURRENT main-owned id_token for the collab WSS
   * bearer — the ONE sanctioned full-token crossing to the renderer
   * (`app-contracts` AuthPort.getToken). Resolved through the
   * SignedInSession StaleSessionError guard: null when signed-out / stale / a
   * refresh failed. NEVER the refresh or access token, never a header.
   */
  authGetCollabToken: 'auth:getCollabToken',
  /** push main→renderer: SessionView fan-out on session/org changes. */
  authSessionChanged: 'auth:sessionChanged',
  /**
   * invoke(StartRecordingRequest) → StartRecordingResult. Route the shared
   * record button to main's native RecordingService: resolve the capture
   * mode through the permission gate + launch the supervised pipeline. Every
   * outcome is a typed result (busy / permission-denied / no-session) — never a
   * rejected invoke; the mic-only degrade surfaces through the state push below.
   */
  recordingStart: 'recording:start',
  /** invoke(StopRecordingRequest) → void. Gracefully stop + finalize a recording. */
  recordingStop: 'recording:stop',
  /** Claim completion once across main and floating windows. */
  recordingClaimCompletion: 'recording:claimCompletion',
  /** invoke(RecordingControlRequest) → boolean. Flush and pause without finalizing. */
  recordingPause: 'recording:pause',
  /** invoke(RecordingControlRequest) → boolean. Resume the same recording timeline. */
  recordingResume: 'recording:resume',
  /**
   * push main→renderer: the sanitized RecordingState — status, effective +
   * requested capture mode, live transcript segments, elapsedMs, recording/note
   * ids. Token-free by construction (the auth-sentinel scan stays clean). Drives
   * the shared dock/transcript UI identically to web's MediaRecorder path.
   */
  recordingStateChanged: 'recording:stateChanged',
  /** invoke → DeviceSettings. The current device-local preferences. */
  settingsGet: 'settings:get',
  /** invoke(DeviceSettingsPatch) → void. Merge a partial patch (fire-and-forget). */
  settingsSet: 'settings:set',
  /** push main→renderer: DeviceSettings fan-out on any settings change. */
  settingsChanged: 'settings:changed',
  /**
   * Local whisper model manager. Device state shared by both
   * modes: the catalogue × installed rows × active downloads. The verbs are
   * fire-and-forget — every outcome (progress, refusal, failure) lands in the
   * next `models:stateChanged` snapshot rather than a rejected invoke.
   */
  /** invoke → ModelsStateView. The current catalogue/installed/download snapshot. */
  modelsGetState: 'models:getState',
  /** invoke(ModelRequest) → void. Start a supervised download (progress rides the push). */
  modelsDownload: 'models:download',
  /** invoke(ModelRequest) → void. Cancel an in-flight download (its .part is removed). */
  modelsCancelDownload: 'models:cancelDownload',
  /** invoke(ModelRequest) → void. Delete an installed model (file + row). */
  modelsDelete: 'models:delete',
  /** push main→renderer: ModelsStateView fan-out on any change (throttled progress). */
  modelsStateChanged: 'models:stateChanged',
  /** invoke → UpdateCheckResult. Trigger an update check; disabled builds return `disabled`. */
  capabilityCheckUpdates: 'capability:checkUpdates',
  /** invoke → UpdateStateView. The current live updater view. */
  updaterGetState: 'updater:getState',
  /** push main→renderer: UpdateStateView fan-out on any updater state change. */
  updaterStateChanged: 'updater:stateChanged',
  /** invoke → void. Restart into a staged update (no-op when nothing staged). */
  updaterQuitInstall: 'updater:quitInstall',
  /** invoke → void. Dismiss the current update prompt (force is non-dismissable). */
  updaterDismissPrompt: 'updater:dismissPrompt',
  /** invoke → void. Reveal the app log file for diagnostics. */
  capabilityExportLogs: 'capability:exportLogs',
  /** invoke → void. Relaunch without clearing any device state. */
  capabilityRestartApp: 'capability:restartApp',
  /**
   * invoke(ResetAppRequest?) → void. Erase the device state, then relaunch:
   * product stores, downloaded models, saved keys, AI/transcription settings,
   * and the telemetry identity. With `mode` it is the MODE SWITCH: every account is
   * signed out and the next boot comes up in that mode. Destructive — the
   * renderer gates it behind a confirm.
   */
  capabilityResetApp: 'capability:resetApp',
  /**
   * invoke → AppModeState. The boot-resolved mode plus
   * whether a mode was ever CHOSEN (the `app:mode` row exists). A fresh
   * install resolves 'cloud' by default but `chosen: false` — the first-run
   * chooser keys on that, which the frozen EnvDescriptor cannot express.
   */
  capabilityGetAppModeState: 'capability:getAppModeState',
  /**
   * invoke(ChooseAppModeRequest) → ChooseAppModeResult. The
   * first-run choice: persists the mode; when it differs from the mode this
   * process booted with, main relaunches (the mode is immutable per process).
   */
  capabilityChooseAppMode: 'capability:chooseAppMode',
  /** invoke → PermissionStatuses. The current mic + system-audio statuses. */
  capabilityGetPermissions: 'capability:getPermissions',
  /**
   * invoke(PermissionRequest) → PermissionStatuses. Prompt for a permission
   * (mic → the OS TCC prompt), then resolve the refreshed statuses.
   */
  capabilityRequestPermission: 'capability:requestPermission',
  /** invoke(OpenSystemSettingsRequest) → void. Open the OS privacy pane. */
  capabilityOpenSystemSettings: 'capability:openSystemSettings',
  /** invoke → AppleCalendarStatus. Reads the signed-in EventKit service state. */
  capabilityGetAppleCalendarStatus: 'capability:getAppleCalendarStatus',
  /** invoke → AppleCalendarStatus. Explicitly prompts for EventKit access. */
  capabilityEnableAppleCalendar: 'capability:enableAppleCalendar',
  /** invoke → AppleCalendarStatus. Publishes a fresh bounded EventKit snapshot. */
  capabilityRefreshAppleCalendar: 'capability:refreshAppleCalendar',
  /**
   * The BYOK transcription API key. The key lives ONLY in
   * main's secure store — never in DeviceSettings (those cross to the renderer
   * on every push) and never read back over IPC: `has` answers a boolean.
   */
  /** invoke(TranscriptionByokKeyRequest) → void. Store (replace) the key. */
  capabilitySetTranscriptionByokKey: 'capability:setTranscriptionByokKey',
  /** invoke → void. Remove the stored key. */
  capabilityClearTranscriptionByokKey: 'capability:clearTranscriptionByokKey',
  /** invoke → boolean. Whether a key is stored — never the key itself. */
  capabilityHasTranscriptionByokKey: 'capability:hasTranscriptionByokKey',
  /**
   * The AI provider API keys. One secure-store slot per
   * provider kind; the same custody rules as the BYOK transcription key —
   * never in DeviceSettings, never read back over IPC.
   */
  /** invoke(AiProviderKeyRequest) → void. Store (replace) a provider's key. */
  capabilitySetAiProviderKey: 'capability:setAiProviderKey',
  /** invoke(AiProviderRequest) → void. Remove a provider's stored key. */
  capabilityClearAiProviderKey: 'capability:clearAiProviderKey',
  /** invoke(AiProviderRequest) → boolean. Whether a key is stored for the provider. */
  capabilityHasAiProviderKey: 'capability:hasAiProviderKey',
  /** invoke(AiProviderRequest) → AiModelListing. The provider's live model catalogue (best-effort). */
  capabilityListAiModels: 'capability:listAiModels',
  /**
   * invoke(ThemeSource) → void. Mirrors the renderer's stored theme preference
   * onto `nativeTheme.themeSource`, so the native chrome AGREES with the in-app
   * theme instead of following the OS. Load-bearing for the macOS vibrancy
   * sidebar: the NSVisualEffectView's material tracks the OS appearance, so an
   * OS-dark / app-light pair renders a dark blur under light sidebar text.
   * The renderer stays the source of truth (localStorage 'theme').
   */
  themeSetSource: 'theme:setSource',
  /**
   * invoke(RecordingE2ECommand) → void. Test-only recording driver (push a fake
   * RecordingState / force the next start result) so the packaged e2e can
   * exercise the render + result mapping without a capture device or the cloud.
   * Registered ONLY when PRISMICAL_E2E=1.
   */
  e2eRecording: 'e2e:recording',
} as const;

/** The one-shot channel a stream's MessagePort is posted on (main→renderer). */
export const streamPortChannel = (streamId: string): string => `transport:stream:${streamId}`;

/**
 * window.postMessage marker used by the preload to forward a received
 * MessagePort into the main world (MessagePorts cannot cross contextBridge;
 * this is the Electron-documented pattern).
 */
export const STREAM_PORT_WINDOW_MESSAGE = 'prismical:stream-port' as const;

/** The one-shot channel a collab log's MessagePort is posted on (main→renderer). */
export const collabPortChannel = (openId: string): string => `collab:port:${openId}`;

/** window.postMessage marker for forwarding a received collab MessagePort into the main world. */
export const COLLAB_PORT_WINDOW_MESSAGE = 'prismical:collab-port' as const;

// ---------------------------------------------------------------------------
// env:get
// ---------------------------------------------------------------------------

/**
 * What the renderer is allowed to know about its environment. Deliberately
 * excludes backend API endpoints/OAuth config — the renderer cannot reach the
 * backend by construction; transport goes through main.
 */
export const envDescriptorSchema = z.object({
  noteWsUrl: z.string().url(),
  webAppOrigin: z.string().url(),
  analyticsKey: z.string().nullable(),
  // PostHog ingestion host (the reverse proxy). Desktop-only (web resolves its
  // own host); null when analytics is disabled (dev / E2E).
  analyticsHost: z.string().nullable(),
  /**
   * The app's operating mode. Main resolves the user's first-run choice. The
   * renderer's posthog-js init KEYS on it — telemetry policy differs by mode
   * (cloud: service telemetry under the ToS; local: opted-out baseline
   * config) — so nothing may beacon before the mode is known.
   */
  appMode: z.enum(['cloud', 'local']),
  platform: z.string(),
  appVersion: z.string(),
  /** One immutable, main-resolved interface locale for this process. */
  applicationLocale: applicationLocaleSchema,
  /** Normalized OS locale, used to evaluate a future "System default" selection. */
  systemLocale: applicationLocaleSchema,
});
export type EnvDescriptor = z.infer<typeof envDescriptorSchema>;

// ---------------------------------------------------------------------------
// transport:request (unary)
// ---------------------------------------------------------------------------

/** The only path prefix the CloudTransport lane will ever proxy. */
export const TRANSPORT_PATH_PREFIX = '/apps/v1/me';

/**
 * The transport lane only proxies /apps/v1/me and its descendants. This is a
 * literal-prefix check hardened against traversal: a '..' path segment escapes
 * the prefix once a URL resolver normalizes it, and a backslash is a separator
 * after normalization — reject both before the prefix match (the real fetch
 * trusts this validator). Query strings are left intact (they never resolve as
 * path segments).
 */
export const isAllowedTransportPath = (path: string): boolean => {
  if (path.includes('\\')) return false;
  if (path.split('/').includes('..')) return false;
  return path === TRANSPORT_PATH_PREFIX || path.startsWith(`${TRANSPORT_PATH_PREFIX}/`);
};

export const transportRequestSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1),
  query: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
});
export type TransportRequest = z.infer<typeof transportRequestSchema>;

export type TransportErrorCode =
  | 'INVALID_REQUEST'
  | 'PATH_NOT_ALLOWED'
  | 'UNKNOWN_SENDER'
  | 'INTERNAL';

export type TransportResponse =
  | { readonly ok: true; readonly status: number; readonly bodyJson: unknown }
  | { readonly error: { readonly code: TransportErrorCode; readonly message?: string } };

// ---------------------------------------------------------------------------
// transport:openStream (MessagePort streaming lane)
// ---------------------------------------------------------------------------

export const openStreamRequestSchema = z.object({
  /** Generated by the preload (UUID) so the port listener exists before the invoke. */
  streamId: z.string().uuid(),
  method: z.literal('POST'),
  path: z.string().min(1),
  body: z.unknown().optional(),
});
export type OpenStreamRequest = z.infer<typeof openStreamRequestSchema>;

export type OpenStreamResponse =
  | { readonly ok: true; readonly streamId: string }
  | {
      readonly error: {
        readonly code: TransportErrorCode | 'DUPLICATE_STREAM';
        readonly message?: string;
      };
    };

/** Messages the MAIN side emits on the stream port (NDJSON-framed by the renderer helper). */
export const streamChunkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chunk'), index: z.number().int(), text: z.string() }),
  z.object({ type: z.literal('tool-approval-required'), toolCallId: z.string() }),
  z.object({ type: z.literal('done'), resumedWithParts: z.number().int().optional() }),
]);
export type StreamChunk = z.infer<typeof streamChunkSchema>;

/** Messages the RENDERER may send back on the stream port. */
export const inboundStreamMessageSchema = z.discriminatedUnion('type', [
  // On approval resume, the renderer re-sends full message parts.
  z.object({ type: z.literal('resume'), parts: z.array(z.unknown()) }),
  z.object({ type: z.literal('abort') }),
]);
export type InboundStreamMessage = z.infer<typeof inboundStreamMessageSchema>;

// ---------------------------------------------------------------------------
// collab:open (note-body log lane)
// ---------------------------------------------------------------------------

/**
 * Opens one note's Yjs update-log lane: main replays the persisted log over a
 * dedicated MessagePort, appends/relays renderer updates (opaque blobs — main
 * never decodes Yjs), and projects flushes into the product store. Same
 * port-handoff mechanics as transport:openStream (once-listener-before-invoke
 * on collabPortChannel(openId)), but with its OWN bidirectional message
 * vocabulary — the stream lane's bytes-only protocol treats any structured
 * message as terminal, so the two lanes cannot share a schema.
 */
export const collabOpenRequestSchema = z
  .object({
    /** Generated by the preload (UUID) so the port listener exists before the invoke. */
    openId: z.string().uuid(),
    noteId: z.string().min(1),
  })
  .strict();
export type CollabOpenRequest = z.infer<typeof collabOpenRequestSchema>;

export const collabOpenResponseSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z
    .object({
      error: z
        .object({
          code: z.enum([
            'INVALID_REQUEST',
            'UNKNOWN_SENDER',
            'NO_WORKSPACE',
            'DUPLICATE',
            'INTERNAL',
          ]),
          message: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type CollabOpenResponse = z.infer<typeof collabOpenResponseSchema>;

/** Messages the RENDERER may send on the collab port (Yjs blobs stay opaque to main). */
export const inboundCollabMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update'), data: z.instanceof(Uint8Array) }).strict(),
  z
    .object({
      type: z.literal('flush'),
      text: z.string(),
      markdown: z.string().nullable(),
      firstLine: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('compact'),
      upTo: z.number().int().nonnegative(),
      state: z.instanceof(Uint8Array),
    })
    .strict(),
]);
export type InboundCollabMessage = z.infer<typeof inboundCollabMessageSchema>;

/** Messages the MAIN side emits on the collab port (log replay, then the hydrated marker). */
export const outboundCollabMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update'), data: z.instanceof(Uint8Array) }).strict(),
  z
    .object({
      type: z.literal('hydrated'),
      seq: z.number().int().nonnegative(),
      count: z.number().int().nonnegative(),
    })
    .strict(),
  /**
   * An append did NOT reach the store: the log now has a gap that makes every
   * LATER update unapplicable on replay, so the sender must re-seed it with a
   * full state snapshot (a compact over the hydrated prefix).
   */
  z.object({ type: z.literal('resync') }).strict(),
]);
export type OutboundCollabMessage = z.infer<typeof outboundCollabMessageSchema>;

/** Test-only stats surfaced via e2e:streamStats (PRISMICAL_E2E=1 builds only). */
export interface StreamStats {
  readonly opened: number;
  readonly active: number;
  readonly completed: number;
  readonly aborted: number;
}

/**
 * Test-only SignedInRuntime lifecycle observability, surfaced via
 * e2e:sessionProbe (PRISMICAL_E2E=1 builds only). Counters cover the process
 * lifetime; `pinned` is the CURRENT live session's identity or null.
 */
export interface SessionProbe {
  readonly acquires: number;
  readonly releases: number;
  readonly acquireFailures: number;
  readonly pinned: { readonly sub: string; readonly orgId: string | null } | null;
}

// ---------------------------------------------------------------------------
// nav:push (main→renderer)
// ---------------------------------------------------------------------------

export const navPushSchema = z.object({
  path: z.string().min(1),
});
export type NavPush = z.infer<typeof navPushSchema>;

// ---------------------------------------------------------------------------
// float:* (the floating note, the dock's expanded mode)
// ---------------------------------------------------------------------------

/**
 * float:open arg. `noteId: null` opens THE SLOT — the note the float last
 * held this session (main resolves it), or a fresh quick note when the slot is
 * empty (the float view creates it). `.strict()` like every request schema.
 */
export const floatOpenRequestSchema = z.object({ noteId: z.string().nullable() }).strict();
export type FloatOpenRequest = z.infer<typeof floatOpenRequestSchema>;

/**
 * The pushed float slot state: whether the float window is open and which note
 * the slot holds (survives a collapse; cleared by dock-back). `.strip()` on the
 * push lane, mirroring every other main→renderer view.
 */
export const floatStateSchema = z
  .object({ open: z.boolean(), noteId: z.string().nullable() })
  .strip();
export type FloatStateView = z.infer<typeof floatStateSchema>;

// ---------------------------------------------------------------------------
// auth:* (sanitized session over IPC; tokens never cross)
// ---------------------------------------------------------------------------

/**
 * One signed-in account as the renderer sees it. `.strict()` makes the shape
 * structurally incapable of carrying tokens: a token-shaped key (refreshToken,
 * idToken, accessToken, token, …) fails the parse instead of being stripped —
 * the sentinel scans build on this.
 */
export const sessionAccountSchema = z
  .object({
    sub: z.string().min(1),
    email: z.string().min(1),
    name: z.string().optional(),
    activeOrgId: z.string().optional(),
  })
  .strict();
export type SessionAccount = z.infer<typeof sessionAccountSchema>;

/** Sign-in gate state: pending/offline are explicit, never a fake shell. */
export const sessionGateStateSchema = z.enum([
  'signed-out',
  'signing-in',
  'signed-in',
  'refreshing',
  'offline',
]);
export type SessionGateState = z.infer<typeof sessionGateStateSchema>;

/** The sanitized multi-account session view crossing IPC. */
export const sessionViewSchema = z
  .object({
    state: sessionGateStateSchema,
    accounts: z.array(sessionAccountSchema),
    activeSub: z.string().min(1).optional(),
  })
  .strict();
export type SessionView = z.infer<typeof sessionViewSchema>;

/**
 * auth:signIn resolves when the browser flow STARTS (or immediately fails);
 * completion arrives as an auth:sessionChanged push. NOT_CONFIGURED surfaces
 * an empty client ID.
 */
export const signInResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum([
        'NOT_CONFIGURED',
        'FLOW_ALREADY_PENDING',
        'BROWSER_LAUNCH_FAILED',
        'UNKNOWN_SENDER',
        'INTERNAL',
      ]),
      message: z.string().optional(),
    })
    .strict(),
]);
export type SignInResult = z.infer<typeof signInResultSchema>;

const safeWebReturnPath = /^\/(?!\/)[A-Za-z0-9_\-./?=&%#]*$/;
export const openWebSessionRequestSchema = z
  .object({
    returnPath: z.string().regex(safeWebReturnPath),
    /** Sanitized active-org selector; the server revalidates live membership before using it. */
    activeOrgId: z.string().min(1).max(255).optional(),
  })
  .strict();
export type OpenWebSessionRequest = z.infer<typeof openWebSessionRequestSchema>;

export const signOutRequestSchema = z
  .object({
    /** Absent ⇒ sign out the active account; set ⇒ per-account sign-out. */
    sub: z.string().min(1).optional(),
  })
  .strict();
export type SignOutRequest = z.infer<typeof signOutRequestSchema>;

/**
 * auth:switchOrg arg: the org the active account switches to. Validated
 * in MAIN against the verified org_users claim — an org that isn't a membership
 * is ignored (never trusted), so this schema only pins the wire shape.
 */
export const switchOrgRequestSchema = z.object({ orgId: z.string().min(1) }).strict();
export type SwitchOrgRequest = z.infer<typeof switchOrgRequestSchema>;

/**
 * auth:switchAccount arg: the sub of the already-signed-in account to make
 * active. Validated in MAIN against the signed-in roster (unknown sub ignored).
 */
export const switchAccountRequestSchema = z.object({ sub: z.string().min(1) }).strict();
export type SwitchAccountRequest = z.infer<typeof switchAccountRequestSchema>;

/** Push payload for auth:sessionChanged — exactly the sanitized view. */
export const sessionChangedPushSchema = sessionViewSchema;
export type SessionChangedPush = SessionView;

/**
 * auth:getCollabToken result — the collab WSS bearer id_token, or null when no
 * live session can mint one (signed-out / stale / failed refresh). This is the
 * ONE wire type that legitimately carries a full token to the renderer (the
 * one sanctioned exception the sentinel scans whitelist); every OTHER IPC
 * surface stays structurally token-free (the sessionView `.strict()` shape).
 */
export const collabTokenResultSchema = z.string().nullable();
export type CollabTokenResult = z.infer<typeof collabTokenResultSchema>;

// ---------------------------------------------------------------------------
// recording:* (the shared record button + transcript over IPC)
// ---------------------------------------------------------------------------

export const captureModeSchema = z.enum(['mic', 'system', 'dual']);
export type CaptureMode = z.infer<typeof captureModeSchema>;

/**
 * recording:start arg. `captureMode` is the mode the caller REQUESTS (the
 * platform adapter picks dual on desktop); the permission gate may degrade it to
 * mic and report that back through the state push. `noteId` binds the recording
 * to a note (WRITE-checked server-side); null/omitted ⇒ standalone.
 */
export const startRecordingRequestSchema = z
  .object({
    captureMode: captureModeSchema,
    noteId: z.string().min(1).nullable().optional(),
    title: z.string().optional(),
    /**
     * Auto-pause policy for this session. The renderer already holds the org's gate
     * + tuning, so it passes them at start rather than making main look them up; absent ⇒ off.
     * Bounded here as well as server-side — this crosses the sanitized membrane, and a renderer
     * that sent 0 would otherwise pause the moment the minimum-session window elapsed.
     */
    autoPause: z
      .object({
        silenceSeconds: z.number().finite().min(5).max(3600),
        graceSeconds: z.number().finite().min(1).max(600),
        autoStopAfterPausedMinutes: z.number().finite().min(0).max(1440),
      })
      .strict()
      .optional(),
  })
  .strict();
export type StartRecordingRequest = z.infer<typeof startRecordingRequestSchema>;

/**
 * recording:start result — the minted id, or a typed reason the recording did
 * NOT begin. A rejected invoke never crosses the membrane (the renderer renders
 * the reason). `.strict()` keeps the shape token-free like every other surface.
 */
export const startRecordingResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), recordingId: z.string().min(1) }).strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum([
        'permission-denied',
        'busy',
        'no-session',
        'model-missing',
        'storage-unavailable',
      ]),
    })
    .strict(),
]);
export type StartRecordingResult = z.infer<typeof startRecordingResultSchema>;

export const stopRecordingRequestSchema = z.object({ recordingId: z.string().min(1) }).strict();
export type StopRecordingRequest = z.infer<typeof stopRecordingRequestSchema>;
export const recordingControlRequestSchema = stopRecordingRequestSchema;
export type RecordingControlRequest = z.infer<typeof recordingControlRequestSchema>;

/**
 * One transcript segment as the renderer sees it — only these display fields
 * ever cross. `.strip()` (NOT `.strict()`): the server's transcript_segment row
 * carries extra operational metadata (`createdAt`, `updatedAt`, `orgUserId`,
 * `isFinal`, `deletedAt`) that must NOT reach the renderer but must also NOT
 * fail the whole state push. Stripping drops every unlisted key — including any
 * hypothetical token-shaped one — so the surface stays sanitized (the sentinel
 * goal) while legitimate server extras are silently discarded rather than
 * rejecting the push and losing the live transcript.
 */
export const recordingSegmentSchema = z
  .object({
    id: z.string(),
    recordingId: z.string(),
    source: z.string(),
    speaker: z.string(),
    text: z.string(),
    startTimeMs: z.number(),
    endTimeMs: z.number(),
    segmentOrder: z.number(),
  })
  .strip();
export type RecordingSegmentView = z.infer<typeof recordingSegmentSchema>;

/**
 * The sanitized RecordingState pushed on recording:stateChanged. `captureMode`
 * is the effective mode; when it differs from `requestedCaptureMode` the gate
 * degraded system/dual → mic (the UI shows "mic only"). `.strict()` keeps it
 * structurally token-free (segments carry transcript text + ids, nothing else).
 */
export const recordingStateViewSchema = z
  .object({
    recordingId: z.string().nullable(),
    status: z.enum(['idle', 'starting', 'recording', 'paused', 'stopping', 'error']),
    captureMode: captureModeSchema.nullable(),
    requestedCaptureMode: captureModeSchema.nullable(),
    micSource: z.enum(['meeting-app', 'system-default', 'unavailable']),
    noteId: z.string().nullable(),
    segments: z.array(recordingSegmentSchema),
    elapsedMs: z.number(),
    /** Epoch ms when elapsedMs was sampled; used as the renderer-side timer anchor. */
    elapsedAt: z.number().finite().nullable().optional(),
    /** Accumulated paused wall time (diagnostics/backward-compatible timer field). */
    pausedAccumMs: z.number().finite().optional(),
    /**
     * Recording start (epoch ms). The dock's timer fields ride the state
     * without breaking `.strict()`. Optional: e2e fixtures and the web adapter
     * omit it until the in-app dock derives its timer the same way.
     */
    startedAt: z.number().finite().nullable().optional(),
    /**
     * The live "Still there?" countdown, or null. The notify window renders the CARD
     * from main's own state, so this crossing exists for the in-app surfaces: it is how the shared
     * transcript panel and away pill learn that a pause was ours rather than the user's, and say
     * "Paused - no sound detected" instead of a bare "Paused" — the same copy web shows.
     */
    autoPausePrompt: z
      .object({ graceMs: z.number().finite(), deadlineMs: z.number().finite() })
      .strict()
      .nullable()
      .optional(),
    /**
     * Main has passed the auto-stop deadline and is asking the RENDERER to stop —
     * the renderer owns the post-stop work, so main must not stop behind its back.
     */
    autoStopRequested: z.boolean().optional(),
  })
  .strict();
export type RecordingStateView = z.infer<typeof recordingStateViewSchema>;

/**
 * The test-only recording driver (e2e:recording): push a fabricated state to the
 * renderer, or force the next recording:start result — so the e2e can drive the
 * transcript render + the permission-denied result without a device or the cloud.
 */
export const recordingE2ECommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('push'), view: recordingStateViewSchema }).strict(),
  z.object({ kind: z.literal('forceStart'), result: startRecordingResultSchema }).strict(),
]);
export type RecordingE2ECommand = z.infer<typeof recordingE2ECommandSchema>;

// ---------------------------------------------------------------------------
// settings:* (device-local preferences over IPC)
//
// The MAIN-side mirror of app-contracts' renderer-facing DeviceSettings (kept
// field-for-field in sync — a desktop test pins the two DEFAULT constants equal,
// the same independent-mirror pattern the recording/transport contracts use so
// neither contracts package depends on the other).
// ---------------------------------------------------------------------------

export const widgetVisibilitySchema = z.enum(['always', 'while-recording', 'never']);
export type WidgetVisibility = z.infer<typeof widgetVisibilitySchema>;

export const updateChannelSchema = z.enum(['stable', 'beta']);
export type UpdateChannel = z.infer<typeof updateChannelSchema>;

// --- Dock settings ---------------------------------------------------------
// The dock (evolved floating widget) drags freely on both axes and persists a
// normalized anchor PER DISPLAY; the floating note persists normalized bounds
// per display. `.finite()` everywhere — a NaN/Infinity anchor row must fall to
// the default at decode, never reach the geometry math. `.strip()` on the
// record values (membrane stance: a stray key is dropped, not fatal).

/** A 2-axis normalized anchor within a display's margin bands (0..1 each). */
export const dockAnchorSchema = z
  .object({ nx: z.number().finite(), ny: z.number().finite() })
  .strip();
export type DockAnchorSetting = z.infer<typeof dockAnchorSchema>;

/** Per-display dock anchors, keyed by `String(display.id)`. */
export const dockAnchorsSchema = z.record(z.string(), dockAnchorSchema);
export type DockAnchorsSetting = z.infer<typeof dockAnchorsSchema>;

/** The floating note's normalized bounds (position bands + size fractions). */
export const floatNoteNormBoundsSchema = z
  .object({
    nx: z.number().finite(),
    ny: z.number().finite(),
    nw: z.number().finite(),
    nh: z.number().finite(),
  })
  .strip();
export type FloatNoteNormBoundsSetting = z.infer<typeof floatNoteNormBoundsSchema>;

/** Per-display floating-note bounds, keyed by `String(display.id)`. */
export const floatNoteBoundsSchema = z.record(z.string(), floatNoteNormBoundsSchema);
export type FloatNoteBoundsSetting = z.infer<typeof floatNoteBoundsSchema>;

/**
 * The floating-note global hotkey, stored as an Electron accelerator string
 * ('' = disabled). The default renders as ⌥⇧N in the settings UI; validation of
 * the accelerator format happens at registration, not on the wire.
 */
export const DEFAULT_DOCK_HOTKEY = 'Alt+Shift+N';

// --- Transcription engine --------------------------------------------------
// The engine that transcribes desktop recordings is orthogonal to the app
// mode. ONE record field keeps the four knobs together (a patch replaces the
// whole record, like dockAnchors). The BYOK
// API key is NOT here — it lives in the SecureStore and never crosses to the
// renderer; only the non-secret base URL + model name ride the settings.

export const transcriptionEngineSchema = z.enum(['cloud', 'local', 'byok']);
export type TranscriptionEngine = z.infer<typeof transcriptionEngineSchema>;

/**
 * `modelId` is a local-model catalogue id (null = the recommended default);
 * `byokBaseUrl`/`byokModel` describe an OpenAI-compatible endpoint. Main
 * resolves the EFFECTIVE engine per recording (local mode coerces 'cloud' →
 * 'local'); the stored preference is what the user picked.
 */
export const transcriptionSettingSchema = z
  .object({
    engine: transcriptionEngineSchema,
    modelId: z.string().nullable(),
    byokBaseUrl: z.string().nullable(),
    byokModel: z.string().nullable(),
  })
  .strip();
export type TranscriptionSetting = z.infer<typeof transcriptionSettingSchema>;

export const DEFAULT_TRANSCRIPTION_SETTING: TranscriptionSetting = {
  engine: 'cloud',
  modelId: null,
  byokBaseUrl: null,
  byokModel: null,
};

// ---------------------------------------------------------------------------
// AI provider. The language-model provider used by the local Ask/Skills lanes:
// a BYO key (OpenAI, Anthropic, any
// OpenAI-compatible endpoint) or a local Ollama runtime. ONE record, like the
// transcription setting: `model` is the provider's model id (null = the
// provider default), `baseUrl` the endpoint for openai-compatible / ollama
// (null = the provider default). API keys are NOT here — they live in the
// SecureStore, one slot per provider kind, and never cross to the renderer.
// ---------------------------------------------------------------------------

export const aiProviderKindSchema = z.enum(['openai', 'anthropic', 'openai-compatible', 'ollama']);
export type AiProviderKind = z.infer<typeof aiProviderKindSchema>;

export const aiProviderSettingSchema = z
  .object({
    provider: aiProviderKindSchema,
    model: z.string().nullable(),
    baseUrl: z.string().nullable(),
  })
  .strip();
export type AiProviderSetting = z.infer<typeof aiProviderSettingSchema>;

export const DEFAULT_AI_PROVIDER_SETTING: AiProviderSetting = {
  provider: 'openai',
  model: null,
  baseUrl: null,
};

/**
 * The full DeviceSettings crossing settings:get / settings:changed. `.strip()`
 * (NOT `.strict()`, mirroring recordingSegment): the value is main's own seeded
 * state so no unknown key is expected, but stripping drops any stray key —
 * including a hypothetical token-shaped one — so a belt-and-braces re-parse
 * before the push can never fail (which would silently drop settings) while the
 * surface still stays sanitized. `widgetNormalizedY` is a bare number here; MAIN
 * clamps it to [0,1] before it is ever seeded/pushed (the wire trusts that).
 */
export const deviceSettingsSchema = z
  .object({
    launchAtLogin: z.boolean(),
    dockVisible: z.boolean(),
    widgetVisibility: widgetVisibilitySchema,
    /**
     * LEGACY: the old right-edge vertical anchor. Kept as the
     * read-side migration seed for a display with no `dockAnchors` entry yet;
     * no new writes land here.
     */
    widgetNormalizedY: z.number(),
    updateChannel: updateChannelSchema,
    language: applicationLocalePreferenceSchema,
    // --- Dock ---
    dockAnchors: dockAnchorsSchema,
    dockDisplayId: z.string().nullable(),
    floatNoteBounds: floatNoteBoundsSchema,
    meetingNotifications: z.boolean(),
    dockHotkey: z.string(),
    autoExpandOnRecording: z.boolean(),
    dockContentProtection: z.boolean(),
    /**
     * LOCAL-MODE telemetry opt-out. Policy: cloud-mode
     * users get service telemetry under the ToS (this flag is ignored there);
     * local mode honors it.
     */
    telemetryOptOut: z.boolean(),
    /** Transcription engine choice — see transcriptionSettingSchema. */
    transcription: transcriptionSettingSchema,
    /** AI provider choice — see aiProviderSettingSchema. */
    ai: aiProviderSettingSchema,
  })
  .strip();
export type DeviceSettings = z.infer<typeof deviceSettingsSchema>;

/**
 * settings:set arg — a partial patch. `.strict()` (an unknown key rejects the
 * whole invoke, like every other request schema) and every field optional so a
 * screen can flip one preference at a time. MAIN merges + clamps + validates
 * enums again on top of this (the schema pins the wire shape, not the policy).
 */
export const deviceSettingsPatchSchema = z
  .object({
    launchAtLogin: z.boolean().optional(),
    dockVisible: z.boolean().optional(),
    widgetVisibility: widgetVisibilitySchema.optional(),
    widgetNormalizedY: z.number().optional(),
    updateChannel: updateChannelSchema.optional(),
    language: applicationLocalePreferenceSchema.optional(),
    dockAnchors: dockAnchorsSchema.optional(),
    dockDisplayId: z.string().nullable().optional(),
    floatNoteBounds: floatNoteBoundsSchema.optional(),
    meetingNotifications: z.boolean().optional(),
    dockHotkey: z.string().optional(),
    autoExpandOnRecording: z.boolean().optional(),
    dockContentProtection: z.boolean().optional(),
    telemetryOptOut: z.boolean().optional(),
    transcription: transcriptionSettingSchema.optional(),
    ai: aiProviderSettingSchema.optional(),
  })
  .strict();
export type DeviceSettingsPatch = z.infer<typeof deviceSettingsPatchSchema>;

/** The seed for a missing/malformed stored key (mirrors app-contracts). */
export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  launchAtLogin: false,
  dockVisible: true,
  widgetVisibility: 'always',
  widgetNormalizedY: 0.5,
  updateChannel: 'stable',
  language: '',
  dockAnchors: {},
  dockDisplayId: null,
  floatNoteBounds: {},
  meetingNotifications: true,
  dockHotkey: DEFAULT_DOCK_HOTKEY,
  autoExpandOnRecording: false,
  dockContentProtection: false,
  telemetryOptOut: false,
  transcription: DEFAULT_TRANSCRIPTION_SETTING,
  ai: DEFAULT_AI_PROVIDER_SETTING,
};

// ---------------------------------------------------------------------------
// capability:* (native action surface over IPC)
//
// The MAIN-side mirror of app-contracts' renderer-facing PermissionKind /
// PermissionStatus / UpdateStatus unions (kept field-for-field in sync, like
// DeviceSettings). Result shapes are `.strict()` — main builds them, and a stray
// key would be a bug worth failing on rather than stripping.
// ---------------------------------------------------------------------------

export const permissionKindSchema = z.enum(['microphone', 'system-audio']);
export type PermissionKind = z.infer<typeof permissionKindSchema>;

export const permissionStatusSchema = z.enum([
  'granted',
  'denied',
  'not-determined',
  'restricted',
  'unavailable',
  'unknown',
]);
export type PermissionStatus = z.infer<typeof permissionStatusSchema>;

export const permissionStatusesSchema = z
  .object({
    microphone: permissionStatusSchema,
    systemAudio: permissionStatusSchema,
  })
  .strict();
export type PermissionStatuses = z.infer<typeof permissionStatusesSchema>;

export const appleCalendarPermissionStatusSchema = z.enum([
  'granted',
  'denied',
  'not-determined',
  'restricted',
  'write-only',
  'unavailable',
  'unknown',
]);
export type AppleCalendarPermissionStatus = z.infer<typeof appleCalendarPermissionStatusSchema>;

export const appleCalendarStatusSchema = z
  .object({
    permission: appleCalendarPermissionStatusSchema,
    state: z.enum(['disabled', 'ready', 'syncing', 'error']),
    lastRefreshedAt: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type AppleCalendarStatus = z.infer<typeof appleCalendarStatusSchema>;

/** capability:requestPermission / capability:openSystemSettings arg — a single kind. */
export const permissionRequestSchema = z.object({ kind: permissionKindSchema }).strict();
export type PermissionRequest = z.infer<typeof permissionRequestSchema>;

/**
 * capability:setTranscriptionByokKey payload. The ONE crossing
 * that carries the key, renderer → main; main stores it and never echoes it.
 */
export const transcriptionByokKeyRequestSchema = z
  .object({ key: z.string().min(1), baseUrl: z.string().trim().min(1) })
  .strict();
export type TranscriptionByokKeyRequest = z.infer<typeof transcriptionByokKeyRequestSchema>;

// ---------------------------------------------------------------------------
// App mode. The mode is resolved ONCE at boot in main
// (domains/app-mode) and mirrored on EnvDescriptor.appMode; these are the
// first-run chooser + mode-switch crossings.
// ---------------------------------------------------------------------------

export const appModeSchema = z.enum(['cloud', 'local']);
export type AppModeValue = z.infer<typeof appModeSchema>;

/** capability:getAppModeState result: the boot mode + whether the user ever chose one. */
export const appModeStateSchema = z.object({ mode: appModeSchema, chosen: z.boolean() }).strict();
export type AppModeState = z.infer<typeof appModeStateSchema>;

/** capability:chooseAppMode payload: the first-run choice. */
export const chooseAppModeRequestSchema = z.object({ mode: appModeSchema }).strict();
export type ChooseAppModeRequest = z.infer<typeof chooseAppModeRequestSchema>;

/**
 * capability:chooseAppMode result. `relaunch: true` means main is restarting
 * into the chosen mode (the renderer is about to be torn down); `false` means
 * the choice equals the running mode and the renderer simply proceeds.
 */
export const chooseAppModeResultSchema = z.object({ relaunch: z.boolean() }).strict();
export type ChooseAppModeResult = z.infer<typeof chooseAppModeResultSchema>;

/**
 * capability:resetApp payload. Absent / `{}` = the plain device reset (the
 * running mode and the signed-in accounts are kept); `mode` = the mode switch.
 */
export const resetAppRequestSchema = z.object({ mode: appModeSchema.optional() }).strict();
export type ResetAppRequest = z.infer<typeof resetAppRequestSchema>;

/** capability:setAiProviderKey payload: the ONE crossing that carries a key. */
export const aiProviderKeyRequestSchema = z
  .object({ provider: aiProviderKindSchema, key: z.string().min(1) })
  .strict();
export type AiProviderKeyRequest = z.infer<typeof aiProviderKeyRequestSchema>;

/** capability:{clear,has}AiProviderKey payload: which provider. */
export const aiProviderRequestSchema = z.object({ provider: aiProviderKindSchema }).strict();
export type AiProviderRequest = z.infer<typeof aiProviderRequestSchema>;

/** capability:listAiModels payload: which provider; `force` bypasses main's brief catalogue cache. */
export const aiModelListRequestSchema = z
  .object({ provider: aiProviderKindSchema, force: z.boolean().optional() })
  .strict();
export type AiModelListRequest = z.infer<typeof aiModelListRequestSchema>;

/**
 * capability:listAiModels result: the provider's live catalogue (model ids the
 * settings card and the synthetic local instances offer), or why it could not
 * be fetched. `models` is always an array — an error leaves it empty.
 */
export const aiModelListingSchema = z
  .object({
    models: z.array(z.string()),
    error: z.enum(['not-configured', 'unauthorized', 'network', 'unsupported']).nullable(),
  })
  .strip();
export type AiModelListing = z.infer<typeof aiModelListingSchema>;

export const updateStatusSchema = z.enum([
  'disabled',
  'not-available',
  'checking',
  'available',
  'downloaded',
  'error',
]);
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

export const updateCheckResultSchema = z.object({ status: updateStatusSchema }).strict();
export type UpdateCheckResult = z.infer<typeof updateCheckResultSchema>;

/** The pending update prompt (policy action prompt/force + release info). */
export const updatePromptViewSchema = z
  .object({
    action: z.enum(['prompt', 'force']),
    version: z.string().optional(),
    releaseNotes: z.string().optional(),
  })
  .strip();
export type UpdatePromptView = z.infer<typeof updatePromptViewSchema>;

/**
 * The live updater view crossing updater:getState / updater:stateChanged.
 * `.strip()` like deviceSettingsSchema: main's own derived state, re-parsed
 * before every push so the surface stays sanitized without a parse failure ever
 * dropping a state change.
 */
export const updateStateViewSchema = z
  .object({
    status: updateStatusSchema,
    staged: z.boolean(),
    stagedVersion: z.string().nullable(),
    prompt: updatePromptViewSchema.nullable(),
  })
  .strip();
export type UpdateStateView = z.infer<typeof updateStateViewSchema>;

// ---------------------------------------------------------------------------
// Local models — the on-device ASR weights manager
// ---------------------------------------------------------------------------

/** models:download / cancelDownload / delete payload — a catalogue id. */
export const modelRequestSchema = z.object({ modelId: z.string().min(1) }).strict();
export type ModelRequest = z.infer<typeof modelRequestSchema>;

/** What a catalogue entry is for: whisper decoder weights, or VAD weights. */
export const modelKindSchema = z.enum(['whisper', 'vad']);
export type ModelKind = z.infer<typeof modelKindSchema>;

export const modelDownloadStatusSchema = z.enum([
  'downloading',
  'verifying',
  'cancelling',
  'error',
]);
export type ModelDownloadStatus = z.infer<typeof modelDownloadStatusSchema>;

/**
 * Why a download ended in `error` — a closed set so the renderer maps it to
 * copy. `network` covers HTTP status/transport failures (retry resumes the
 * .part); `checksum-mismatch` means the upstream bytes did not match the pinned
 * SHA-1 (the .part is discarded); `insufficient-space` is the pre-flight refusal.
 */
export const modelDownloadErrorSchema = z.enum([
  'network',
  'checksum-mismatch',
  'insufficient-space',
  'io',
]);
export type ModelDownloadError = z.infer<typeof modelDownloadErrorSchema>;

/** Progress for one model — bytes only; the renderer derives the percentage. */
export const modelDownloadViewSchema = z
  .object({
    status: modelDownloadStatusSchema,
    bytesDownloaded: z.number().finite().nonnegative(),
    /** The response's content-length, else the catalogue's approximate size. */
    totalBytes: z.number().finite().nonnegative(),
    error: modelDownloadErrorSchema.nullable(),
  })
  .strip();
export type ModelDownloadView = z.infer<typeof modelDownloadViewSchema>;

/**
 * One catalogue row as the renderer sees it: static catalogue fields (no
 * download URL — the renderer never needs it), the installed flag/time from
 * the operational row, and the active download (null when idle).
 */
export const modelViewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    filename: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    kind: modelKindSchema,
    recommended: z.boolean(),
    installed: z.boolean(),
    installedAt: z.string().nullable(),
    download: modelDownloadViewSchema.nullable(),
  })
  .strip();
export type ModelView = z.infer<typeof modelViewSchema>;

/**
 * The snapshot crossing models:getState / models:stateChanged. `.strip()` like
 * updateStateViewSchema: main's own derived state, re-parsed before every push.
 */
export const modelsStateViewSchema = z
  .object({
    models: z.array(modelViewSchema),
    /** Where the weights live (identity-free; shown in the settings screen). */
    modelsDir: z.string(),
  })
  .strip();
export type ModelsStateView = z.infer<typeof modelsStateViewSchema>;

// ---------------------------------------------------------------------------
// Parse helpers (safeParse wrappers so consumers share one error shape)
// ---------------------------------------------------------------------------

export type ParseResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly issues: ReadonlyArray<string> };

export const toParseResult = <T>(result: z.ZodSafeParseResult<T>): ParseResult<T> =>
  result.success
    ? { success: true, data: result.data }
    : {
        success: false,
        issues: result.error.issues.map(
          issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`
        ),
      };

export const parseTransportRequest = (value: unknown): ParseResult<TransportRequest> =>
  toParseResult(transportRequestSchema.safeParse(value));

export const parseOpenStreamRequest = (value: unknown): ParseResult<OpenStreamRequest> =>
  toParseResult(openStreamRequestSchema.safeParse(value));

export const parseInboundStreamMessage = (value: unknown): ParseResult<InboundStreamMessage> =>
  toParseResult(inboundStreamMessageSchema.safeParse(value));

export const parseCollabOpenRequest = (value: unknown): ParseResult<CollabOpenRequest> =>
  toParseResult(collabOpenRequestSchema.safeParse(value));

export const parseInboundCollabMessage = (value: unknown): ParseResult<InboundCollabMessage> =>
  toParseResult(inboundCollabMessageSchema.safeParse(value));

export const parseOutboundCollabMessage = (value: unknown): ParseResult<OutboundCollabMessage> =>
  toParseResult(outboundCollabMessageSchema.safeParse(value));

export const parseNavPush = (value: unknown): ParseResult<NavPush> =>
  toParseResult(navPushSchema.safeParse(value));

export const parseFloatOpenRequest = (value: unknown): ParseResult<FloatOpenRequest> =>
  toParseResult(floatOpenRequestSchema.safeParse(value));

export const parseFloatState = (value: unknown): ParseResult<FloatStateView> =>
  toParseResult(floatStateSchema.safeParse(value));

export const parseSessionView = (value: unknown): ParseResult<SessionView> =>
  toParseResult(sessionViewSchema.safeParse(value));

export const parseSignInResult = (value: unknown): ParseResult<SignInResult> =>
  toParseResult(signInResultSchema.safeParse(value));

export const parseOpenWebSessionRequest = (value: unknown): ParseResult<OpenWebSessionRequest> =>
  toParseResult(openWebSessionRequestSchema.safeParse(value));

export const parseSignOutRequest = (value: unknown): ParseResult<SignOutRequest> =>
  toParseResult(signOutRequestSchema.safeParse(value));

export const parseSwitchOrgRequest = (value: unknown): ParseResult<SwitchOrgRequest> =>
  toParseResult(switchOrgRequestSchema.safeParse(value));

export const parseSwitchAccountRequest = (value: unknown): ParseResult<SwitchAccountRequest> =>
  toParseResult(switchAccountRequestSchema.safeParse(value));

export const parseSessionChangedPush = (value: unknown): ParseResult<SessionChangedPush> =>
  toParseResult(sessionChangedPushSchema.safeParse(value));

export const parseCollabTokenResult = (value: unknown): ParseResult<CollabTokenResult> =>
  toParseResult(collabTokenResultSchema.safeParse(value));

export const parseStartRecordingRequest = (value: unknown): ParseResult<StartRecordingRequest> =>
  toParseResult(startRecordingRequestSchema.safeParse(value));

export const parseStopRecordingRequest = (value: unknown): ParseResult<StopRecordingRequest> =>
  toParseResult(stopRecordingRequestSchema.safeParse(value));

export const parseRecordingControlRequest = (
  value: unknown
): ParseResult<RecordingControlRequest> =>
  toParseResult(recordingControlRequestSchema.safeParse(value));

export const parseRecordingStateView = (value: unknown): ParseResult<RecordingStateView> =>
  toParseResult(recordingStateViewSchema.safeParse(value));

export const parseRecordingE2ECommand = (value: unknown): ParseResult<RecordingE2ECommand> =>
  toParseResult(recordingE2ECommandSchema.safeParse(value));

export const parseUpdateStateView = (value: unknown): ParseResult<UpdateStateView> =>
  toParseResult(updateStateViewSchema.safeParse(value));

export const parseDeviceSettings = (value: unknown): ParseResult<DeviceSettings> =>
  toParseResult(deviceSettingsSchema.safeParse(value));

export const parseModelRequest = (value: unknown): ParseResult<ModelRequest> =>
  toParseResult(modelRequestSchema.safeParse(value));

export const parseTranscriptionByokKeyRequest = (
  value: unknown
): ParseResult<TranscriptionByokKeyRequest> =>
  toParseResult(transcriptionByokKeyRequestSchema.safeParse(value));

export const parseChooseAppModeRequest = (value: unknown): ParseResult<ChooseAppModeRequest> =>
  toParseResult(chooseAppModeRequestSchema.safeParse(value));

export const parseResetAppRequest = (value: unknown): ParseResult<ResetAppRequest> =>
  toParseResult(resetAppRequestSchema.safeParse(value));

export const parseAiProviderKeyRequest = (value: unknown): ParseResult<AiProviderKeyRequest> =>
  toParseResult(aiProviderKeyRequestSchema.safeParse(value));

export const parseAiProviderRequest = (value: unknown): ParseResult<AiProviderRequest> =>
  toParseResult(aiProviderRequestSchema.safeParse(value));

export const parseAiModelListRequest = (value: unknown): ParseResult<AiModelListRequest> =>
  toParseResult(aiModelListRequestSchema.safeParse(value));

export const parseAiModelListing = (value: unknown): ParseResult<AiModelListing> =>
  toParseResult(aiModelListingSchema.safeParse(value));

export const parseModelsStateView = (value: unknown): ParseResult<ModelsStateView> =>
  toParseResult(modelsStateViewSchema.safeParse(value));

export const parseDeviceSettingsPatch = (value: unknown): ParseResult<DeviceSettingsPatch> =>
  toParseResult(deviceSettingsPatchSchema.safeParse(value));

export const parsePermissionRequest = (value: unknown): ParseResult<PermissionRequest> =>
  toParseResult(permissionRequestSchema.safeParse(value));

export const parseAppleCalendarStatus = (value: unknown): ParseResult<AppleCalendarStatus> =>
  toParseResult(appleCalendarStatusSchema.safeParse(value));

export const parseThemeSource = (value: unknown): ParseResult<ThemeSource> =>
  toParseResult(themeSourceSchema.safeParse(value));

// ---------------------------------------------------------------------------
// The preload surface (typed contract for window.desktop in the main window)
// ---------------------------------------------------------------------------

export interface DesktopStreamHandle {
  readonly streamId: string;
  /** Resolves/rejects with the main process's OpenStreamResponse. */
  readonly opened: Promise<OpenStreamResponse>;
}

export interface DesktopCollabHandle {
  readonly openId: string;
  /** Resolves/rejects with the main process's CollabOpenResponse. */
  readonly opened: Promise<CollabOpenResponse>;
}

export interface MainWindowAuthApi {
  readonly getSession: () => Promise<SessionView>;
  readonly signIn: () => Promise<SignInResult>;
  /** Open a web-app path using the active native account without exposing its token. */
  readonly openWebSession: (request: OpenWebSessionRequest) => Promise<void>;
  readonly signOut: (request?: SignOutRequest) => Promise<void>;
  /**
   * Re-scope the active account to another org. Validated in main against
   * the verified org_users claim; the result is observed through the
   * auth:sessionChanged push (new activeOrgId), never this promise — it resolves
   * regardless (an invalid membership is a logged no-op in main).
   */
  readonly switchOrg: (request: SwitchOrgRequest) => Promise<void>;
  /**
   * Make another already-signed-in account active. Validated in main
   * against the signed-in roster; the switch is observed through the
   * auth:sessionChanged push (new activeSub). Resolves regardless.
   */
  readonly switchAccount: (request: SwitchAccountRequest) => Promise<void>;
  /**
   * The collab WSS bearer: the CURRENT main-owned id_token, or null when no live
   * session can mint one (signed-out / stale / failed refresh). The ONE designed
   * full-token crossing to the renderer — consumed per (re)connect by the
   * note-collab token callback and never persisted. Never the refresh/access token.
   */
  readonly getCollabToken: () => Promise<string | null>;
  /**
   * Multi-subscriber push feed: pushes that arrive before ANY
   * subscriber buffer and replay in order to the next one (cold start); a
   * subscriber attaching while others exist immediately receives the LATEST
   * view; every attached subscriber receives every subsequent push; and
   * subscribing never detaches an existing subscriber. Returns unsubscribe.
   */
  readonly onSessionChanged: (listener: (view: SessionView) => void) => () => void;
}

/**
 * Native recording control for the shared record button: start/stop over
 * IPC + a multi-subscriber state feed (the latest state replays to a late
 * subscriber, mirroring onSessionChanged). The renderer never uploads WAV chunks
 * — main owns the create/chunk/finalize lane.
 */
export interface MainWindowRecordingApi {
  readonly start: (request: StartRecordingRequest) => Promise<StartRecordingResult>;
  readonly stop: (request: StopRecordingRequest) => Promise<void>;
  readonly claimCompletion: (request: RecordingControlRequest) => Promise<boolean>;
  readonly pause: (request: RecordingControlRequest) => Promise<boolean>;
  readonly resume: (request: RecordingControlRequest) => Promise<boolean>;
  readonly onStateChanged: (listener: (state: RecordingStateView) => void) => () => void;
}

/**
 * Device-settings read/write/observe. `get`/`set` invoke main; `set` is
 * fire-and-forget (the observed truth flows back through `onChanged`, which — like
 * onSessionChanged — replays the latest settings to a late subscriber immediately).
 */
export interface MainWindowSettingsApi {
  readonly get: () => Promise<DeviceSettings>;
  readonly set: (patch: DeviceSettingsPatch) => Promise<void>;
  readonly onChanged: (listener: (settings: DeviceSettings) => void) => () => void;
}

/**
 * The in-app theme preference, mirrored to main over `theme:setSource` so
 * `nativeTheme.themeSource` matches it. Same three values the shared
 * ThemeToggle stores under localStorage 'theme' — 'system' must round-trip as
 * 'system' (resolving it to light/dark in the renderer would pin
 * `prefers-color-scheme` and strand the app on one appearance forever).
 */
/**
 * Local whisper model manager: the catalogue-driven
 * download / cancel / delete verbs plus the state observable. Progress rides
 * `onStateChanged` as a full snapshot per (throttled) change; the verbs are
 * fire-and-forget — a refusal (unknown id, already installed, no disk space)
 * shows up in the next state, never as a rejected invoke.
 */
export interface MainWindowModelsApi {
  readonly getState: () => Promise<ModelsStateView>;
  readonly download: (request: ModelRequest) => Promise<void>;
  readonly cancelDownload: (request: ModelRequest) => Promise<void>;
  readonly delete: (request: ModelRequest) => Promise<void>;
  /** Live snapshot pushes; replays the latest to a late subscriber. */
  readonly onStateChanged: (listener: (state: ModelsStateView) => void) => () => void;
}

export const themeSourceSchema = z.enum(['light', 'dark', 'system']);
export type ThemeSource = z.infer<typeof themeSourceSchema>;

/**
 * Native action surface: the settings screens' update-check, logs
 * export, app reset, and permission controls. Each invokes a `capability:*`
 * channel; `resetApp` relaunches the process so its promise never resolves.
 */
export interface MainWindowCapabilitiesApi {
  readonly checkForUpdates: () => Promise<UpdateCheckResult>;
  /** The current live updater view. */
  readonly getUpdateState: () => Promise<UpdateStateView>;
  /** Live updater-view pushes; replays the latest view to a late subscriber. */
  readonly onUpdateState: (listener: (state: UpdateStateView) => void) => () => void;
  /** Restart into a staged update (no-op when nothing is staged). */
  readonly restartToUpdate: () => Promise<void>;
  /** Dismiss the current update prompt (force is non-dismissable). */
  readonly dismissUpdatePrompt: () => Promise<void>;
  readonly exportLogs: () => Promise<void>;
  /** Relaunch without clearing settings, IndexedDB, or recording recovery data. */
  readonly restartApp: () => Promise<void>;
  /** The device reset; with `{ mode }` the mode switch. */
  readonly resetApp: (request?: ResetAppRequest) => Promise<void>;
  /** The boot mode + whether one was ever chosen. */
  readonly getAppModeState: () => Promise<AppModeState>;
  /** The first-run choice; main relaunches when it differs from the boot mode. */
  readonly chooseAppMode: (request: ChooseAppModeRequest) => Promise<ChooseAppModeResult>;
  readonly getPermissionStatus: () => Promise<PermissionStatuses>;
  readonly requestPermission: (request: PermissionRequest) => Promise<PermissionStatuses>;
  readonly openSystemSettings: (request: PermissionRequest) => Promise<void>;
  readonly getAppleCalendarStatus: () => Promise<AppleCalendarStatus>;
  readonly enableAppleCalendar: () => Promise<AppleCalendarStatus>;
  readonly refreshAppleCalendar: () => Promise<AppleCalendarStatus>;
  /** Store the BYOK transcription API key in main's secure store. */
  readonly setTranscriptionByokKey: (request: TranscriptionByokKeyRequest) => Promise<void>;
  /** Remove the stored BYOK key. */
  readonly clearTranscriptionByokKey: () => Promise<void>;
  /** Whether a BYOK key is stored — the key itself never crosses back. */
  readonly hasTranscriptionByokKey: () => Promise<boolean>;
  /** Store an AI provider's API key in main's secure store. */
  readonly setAiProviderKey: (request: AiProviderKeyRequest) => Promise<void>;
  /** Remove a provider's stored key. */
  readonly clearAiProviderKey: (request: AiProviderRequest) => Promise<void>;
  /** Whether a key is stored for the provider — never the key itself. */
  readonly hasAiProviderKey: (request: AiProviderRequest) => Promise<boolean>;
  /** The provider's live model catalogue (best-effort; an error leaves `models` empty; `force` re-fetches). */
  readonly listAiModels: (request: AiModelListRequest) => Promise<AiModelListing>;
}

export interface MainWindowDesktopApi {
  readonly platform: string;
  readonly env: { readonly get: () => Promise<EnvDescriptor> };
  readonly transport: {
    readonly request: (request: TransportRequest) => Promise<TransportResponse>;
    readonly openStream: (request: Omit<OpenStreamRequest, 'streamId'>) => DesktopStreamHandle;
  };
  /** The note-body log lane: one MessagePort per open, keyed by openId. */
  readonly collab: {
    readonly open: (noteId: string) => DesktopCollabHandle;
  };
  readonly nav: { readonly onPush: (listener: (payload: NavPush) => void) => () => void };
  /** Sanitized session reads/pushes + flow start/stop (tokens never cross). */
  readonly auth: MainWindowAuthApi;
  /** Native record button + live transcript state. */
  readonly recording: MainWindowRecordingApi;
  /** Device-local preferences read/write/observe. */
  readonly settings: MainWindowSettingsApi;
  /** Local whisper model manager: download/cancel/delete + state. */
  readonly models: MainWindowModelsApi;
  /** Native action surface: updates, logs/reset, permissions. */
  readonly capabilities: MainWindowCapabilitiesApi;
  /** The floating note: open/collapse/dock-back + slot state. */
  readonly float: {
    /** Open/focus the float on a note; null = the slot (last floated / fresh). */
    readonly open: (noteId: string | null) => void;
    /** Collapse back to the pill — the slot survives. */
    readonly collapse: () => void;
    /** Send the note home: close the float, focus main on it, clear the slot. */
    readonly dockBack: () => void;
    /** Subscribe to the slot state (latest replays to a late subscriber). */
    readonly onState: (listener: (state: FloatStateView) => void) => () => void;
  };
  /** Mirrors the in-app theme onto native chrome (macOS vibrancy material). */
  readonly theme: { readonly setSource: (source: ThemeSource) => Promise<void> };
  /** Present only in PRISMICAL_E2E=1 runs. */
  readonly e2e?: {
    readonly streamStats: () => Promise<StreamStats>;
    readonly authPendingState: () => Promise<string | null>;
    readonly authAuthorizeUrl: () => Promise<string | null>;
    readonly sessionProbe: () => Promise<SessionProbe>;
    readonly recording: (command: RecordingE2ECommand) => Promise<void>;
  };
}
