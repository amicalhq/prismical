/**
 * Desktop port adapters — the `AppPorts` implementation the
 * shared @prismical/app-ui shell mounts against, over `window.desktop.*`.
 *
 * Every seam that reaches the network is routed through main:
 *  - REST rides the injected TransportPort → `window.desktop.transport.request`
 *    (the renderer never fetches the server directly; main resolves the current
 *    guarded identity, calls the allowlisted `/apps/v1/me` path, and returns the
 *    transport envelope. Other paths return PATH_NOT_ALLOWED).
 *  - Ask streaming rides the AskFetch shim over `openStream` (stream.ts).
 *  - Navigation is the TanStack hash router (router.ts) + main-driven pushes.
 *  - Auth is the sanitized `window.desktop.auth` session view (tokens never
 *    cross); switchAccount/switchOrg invoke main's re-scope channels, which
 *    mutate the active account/org and re-broadcast the session. getToken is
 *    wired to `auth.getCollabToken` — the ONE sanctioned full-token crossing for
 *    the collab WSS bearer.
 *
 * The contract-enumeration e2e pins the window.desktop surface exactly, so the
 * getCollabToken addition is reflected there (auth key enumeration).
 */
import * as React from 'react';
import { useLocation, useParams } from '@tanstack/react-router';
import type {
  AppSearchParams,
  AssetPort,
  AuthPort,
  DesktopCapabilityPort,
  EnvDescriptor,
  EnvPort,
  ExternalPort,
  NativeRecordingState,
  NavigationActions,
  RecordingPort,
  RouteParams,
  SessionView,
  TransportPort,
} from '@prismical/app-contracts';
import type {
  AppLinkComponentProps,
  AppPorts,
  AskFetch,
  NavigationAdapter,
} from '@prismical/app-client';
import { LOCAL_FEATURE_FLAGS, LOCAL_WORKSPACE } from '@prismical/desktop-contracts';
import type {
  EnvDescriptor as DesktopEnvDescriptor,
  RecordingStateView,
} from '@prismical/desktop-contracts';
import { router } from '../router';
import { openAskStream } from '../../stream';
import { desktopAnalyticsPort } from '../analytics/posthog';

const log = (message: string, detail?: unknown): void => {
  console.warn(`[desktop-ports] ${message}`, detail ?? '');
};

// --- NavigationPort → TanStack hash router --------------------------------

// Imperative navigation drives the router's history directly with the raw href
// (path + query + hash) — no typed-route coupling, so arbitrary hrefs from the
// shared shell (/notes?folder=x, /people/abc) navigate uniformly.
const navigationActions: NavigationActions = {
  push: href => {
    router.history.push(href);
  },
  replace: href => {
    router.history.replace(href);
  },
  back: () => {
    router.history.back();
  },
};

function useNavigation(): NavigationActions {
  return navigationActions;
}

// Reactive pathname whose identity changes on path change ONLY (never on a
// query-only change) — the shell's per-route transition keys on it.
function usePathname(): string {
  return useLocation({ select: location => location.pathname });
}

// Reactive search params rebuilt from the raw query string; a query-only change
// yields a new URLSearchParams without disturbing usePathname's identity.
function useSearchParams(): AppSearchParams {
  const searchStr = useLocation({ select: location => location.searchStr });
  return React.useMemo(
    () => new URLSearchParams(searchStr.startsWith('?') ? searchStr.slice(1) : searchStr),
    [searchStr]
  );
}

function usePortParams<T extends RouteParams = RouteParams>(): T {
  return useParams({ strict: false }) as T;
}

// The platform link: a plain <a> whose left-click is intercepted onto the router
// history (hash href so copy/right-click still yields a valid in-origin URL, and
// modifier-clicks fall through). Ref forwarded so Radix `asChild` slots work.
const DesktopLink = React.forwardRef<HTMLAnchorElement, AppLinkComponentProps>(function DesktopLink(
  { href, replace, onClick, ...rest },
  ref
) {
  return (
    <a
      ref={ref}
      href={`#${href}`}
      onClick={event => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        if (replace) router.history.replace(href);
        else router.history.push(href);
      }}
      {...rest}
    />
  );
});

const navigationAdapter: NavigationAdapter = {
  useNavigation,
  usePathname,
  useSearchParams,
  useParams: usePortParams,
  Link: DesktopLink,
};

// --- The rest of the ports -------------------------------------------------

function createEnvPort(desktopEnv: DesktopEnvDescriptor): EnvPort {
  // Field-for-field passthrough of main's descriptor; coreApiUrl is absent by
  // construction, so the fetch data lane throws if ever reached — it isn't,
  // because REST goes through the TransportPort below.
  const descriptor: EnvDescriptor = {
    noteWsUrl: desktopEnv.noteWsUrl,
    webAppOrigin: desktopEnv.webAppOrigin,
    analyticsKey: desktopEnv.analyticsKey,
    platform: desktopEnv.platform,
    appVersion: desktopEnv.appVersion,
  };
  return { getEnv: () => descriptor };
}

/**
 * Bodies cross to main by structured clone, NOT by fetch's JSON.stringify —
 * so a Date the sync store keeps on a server-echoed row (`updatedAt`,
 * `createdAt`) would arrive in main as a Date object, which the local backend's
 * wire schemas (string | number) reject with a 400 the cloud lane never sees
 * (main JSON-stringifies before fetching core). One JSON round trip gives both
 * lanes fetch's exact wire semantics, surfaced by the first
 * local-mode write of an echoed note).
 */
const toWireBody = (body: unknown): unknown => JSON.parse(JSON.stringify(body)) as unknown;

const transportPort: TransportPort = {
  request: request =>
    window.desktop.transport.request({
      method: request.method,
      path: request.path,
      ...(request.query ? { query: { ...request.query } } : {}),
      ...(request.body !== undefined ? { body: toWireBody(request.body) } : {}),
    }),
};

// Ask streaming shim: the AI-SDK transport (DefaultChatTransport) calls this
// instead of fetch(). It opens a MessagePort stream through main — which stamps
// Bearer + x-active-org-id and forwards the server's SSE bytes verbatim — and
// returns the streaming Response with `content-type: text/event-stream`, so the
// transport's parseJsonEventStream consumes it exactly as it does core's direct
// SSE on web. Auth headers are dropped on purpose (main stamps them). The two
// pieces the shim MUST wire from `init`:
//  - init.signal → handle.abort(): useChat.stop() aborts the fetch signal; that
//    settles the reader AND interrupts the main producer fiber (which drops the
//    core connection). Approval-resume is NOT wired here — DefaultChatTransport
//    drives it as a fresh sendMessage (a new askFetch/openAskStream), matching
//    web; the port's `.send` resume seam stays available for direct callers.
const askFetch: AskFetch = (_input, init) => {
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
  const handle = openAskStream({ method: 'POST', path: '/apps/v1/me/ask', body });
  const signal = init?.signal;
  if (signal) {
    if (signal.aborted) handle.abort();
    else signal.addEventListener('abort', () => handle.abort(), { once: true });
  }
  return handle.response;
};

// Root-absolute public paths already resolve against the rooted prismical-app://
// document origin, so resolution is identity (same as web's /public).
const assetPort: AssetPort = { resolve: path => path };

// Web-app destinations ask main to mint an authenticated handoff for the active
// desktop account. Other external URLs ride window.open → main's
// setWindowOpenHandler, which shell.openExternal's allowlisted URLs and denies
// the popup.
function createExternalPort(desktopEnv: DesktopEnvDescriptor): ExternalPort {
  const webOrigin = new URL(desktopEnv.webAppOrigin).origin;
  // Local mode has no account to hand off: a web-origin link is just a
  // link. (Every shared caller is flag-gated locally; this keeps the port honest
  // for a docs/marketing URL that happens to sit on the web origin.)
  const handoff = desktopEnv.appMode === 'cloud';
  return {
    openAuthorizationUrl: url => {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    // Desktop OAuth returns through a prismical:// deep link, NOT the web origin.
    // The system-browser round-trip redirects here; the OS routes the deep link to
    // this running app (focusing it) and the deep-link boundary parses
    // `prismical://app/<path>` as a renderer Navigate (mount.tsx onPush →
    // router.history.push). So the connect flow re-enters THIS app on `appPath`
    // rather than stranding the user on the web app in a browser tab. `appPath`
    // already carries its leading "/" (e.g. "/settings/calendar").
    authorizationReturnTo: appPath => `prismical://app${appPath}`,
    openExternalUrl: url => {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
      }
      if (handoff && target.origin === webOrigin) {
        window.desktop.auth
          .getSession()
          .then(session => {
            const activeAccount = session.accounts.find(
              account => account.sub === session.activeSub
            );
            return window.desktop.auth.openWebSession({
              returnPath: target.pathname + target.search + target.hash,
              ...(activeAccount?.activeOrgId ? { activeOrgId: activeAccount.activeOrgId } : {}),
            });
          })
          .catch(error => {
            // Do not fall back to the plain URL: the browser may be signed in as
            // a different account, which is exactly what this handoff prevents.
            log('web handoff failed', error);
          });
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    },
  };
}

// Product events + session replay run through the renderer's
// main-owned telemetry over the explicit preload bridge. The port just
// forwards to that singleton (guarded on init — a disabled build drops silently).
// See ../analytics/posthog.ts.

// Desktop records dual (mic + system) — the native advantage. The permission
// gate in main degrades it to mic when system audio is unavailable and reports
// that back through the state push (requestedCaptureMode !== captureMode ⇒ the
// dock shows "mic only").
const DESKTOP_CAPTURE_MODE = 'dual' as const;

// main→renderer RecordingState (desktop-contracts) → app-contracts shape the
// shared useRecording consumes. Structurally identical; mapped for clarity.
const toNativeState = (view: RecordingStateView): NativeRecordingState => ({
  recordingId: view.recordingId,
  status: view.status,
  captureMode: view.captureMode,
  requestedCaptureMode: view.requestedCaptureMode,
  micSource: view.micSource,
  noteId: view.noteId,
  segments: view.segments,
  elapsedMs: view.elapsedMs,
  elapsedAt: view.elapsedAt ?? null,
  pausedAccumMs: view.pausedAccumMs ?? 0,
  startedAt: view.startedAt ?? null,
  autoStopRequested: view.autoStopRequested ?? false,
});

// The record button routes to main's NATIVE capture + transcription pipeline
// through `control`, which starts/stops over IPC and mirrors main's pushed
// RecordingState into the shared dock/transcript state. `uploadTranscriptionChunk`
// stays a hard throw — the renderer NEVER uploads WAV chunks on desktop; main
// owns the create/chunk/finalize lane (this fires only if the web path is
// mis-mounted on desktop).
const recordingPort: RecordingPort = {
  uploadTranscriptionChunk: () => {
    throw new Error(
      "RecordingPort.uploadTranscriptionChunk is web-only — desktop records through main's native pipeline."
    );
  },
  control: {
    start: async ({ noteId, title, autoPause }) => {
      try {
        return await window.desktop.recording.start({
          captureMode: DESKTOP_CAPTURE_MODE,
          noteId,
          title,
          // Auto-pause policy: resolved renderer-side from the org gate + tuning and
          // handed over per session, so main runs the same machine web does without looking
          // anything up. Absent ⇒ off.
          ...(autoPause ? { autoPause } : {}),
        });
      } catch (error) {
        // A rejected invoke is only ever a malformed/foreign-sender boundary
        // reject (impossible from this adapter) — fold to a generic non-start so
        // useRecording never sees an unhandled rejection.
        log('recording.start invoke failed', error);
        return { ok: false, reason: 'no-session' };
      }
    },
    stop: recordingId => window.desktop.recording.stop({ recordingId }),
    claimCompletion: recordingId =>
      window.desktop.recording.claimCompletion({ recordingId }).catch(error => {
        log('recording.claimCompletion invoke failed', error);
        return false;
      }),
    pause: recordingId =>
      window.desktop.recording.pause({ recordingId }).catch(error => {
        log('recording.pause invoke failed', error);
        return false;
      }),
    resume: recordingId =>
      window.desktop.recording.resume({ recordingId }).catch(error => {
        log('recording.resume invoke failed', error);
        return false;
      }),
    subscribe: listener =>
      window.desktop.recording.onStateChanged(state => listener(toNativeState(state))),
  },
};

// Desktop owns these capabilities. `has` answers true for every settings
// capability (including the 'local-models' / 'transcription-engine' pair —
// the model manager and the engine setting exist in both app modes); the two
// window-chrome capabilities are per-OS (they key the shared shell's
// traffic-light spacer / overlay clearances) and answer from the
// preload-exposed platform. `settings` is the first real per-capability
// handler surface, wired to main over IPC: `get` invokes, `set` is
// fire-and-forget (the observed truth arrives through `subscribe`), and
// `subscribe` SEEDS from `get` exactly like localModels.subscribe below: a
// renderer reload (Cmd+R) recreates the preload push-buffer empty and main
// pushes settings:changed only on a state CHANGE, so a bare subscription would
// leave every useDeviceSettings consumer on DEFAULT_DEVICE_SETTINGS — and the
// settings screens read-modify-WRITE the whole transcription record, so the
// first patch after a reload would persist those defaults over the stored
// record. The pull is dropped once a push has landed (a push is always at
// least as fresh).
const createDesktopCapabilityPort = (appMode: 'local' | 'cloud'): DesktopCapabilityPort => ({
  has: capability => {
    switch (capability) {
      // The AI provider card drives the local lanes only — in cloud mode
      // the server serves Ask/Skills and the card would be a dead control.
      // (BYOK in cloud mode) flips this to true for both modes; the shared
      // screen keeps a named slot either way, never a mode branch.
      case 'ai-provider':
        return appMode === 'local';
      // The app-mode switch card exists in both modes (it names the current
      // mode and offers the other); explicit so the mode-scoped cases above it
      // stay the only per-mode answers.
      case 'app-mode':
        return true;
      case 'window-chrome-mac':
        return window.desktop.platform === 'darwin';
      case 'window-chrome-windows':
        return window.desktop.platform === 'win32';
      case 'apple-calendar':
        return window.desktop.platform === 'darwin';
      default:
        return true;
    }
  },
  // The local feature-flag resolver: the local workspace has no
  // organization to ask, so useFeatureFlag reads this table synchronously —
  // every cloud-only surface answers false, auto-pause answers true. Cloud mode
  // resolves flags from GET /me/organizations exactly as web does (null).
  featureFlags: appMode === 'local' ? LOCAL_FEATURE_FLAGS : null,
  settings: {
    get: () => window.desktop.settings.get(),
    set: patch =>
      window.desktop.settings.set(patch).catch(error => log('settings.set invoke failed', error)),
    subscribe: listener => {
      let active = true;
      let pushed = false;
      const off = window.desktop.settings.onChanged(settings => {
        pushed = true;
        listener(settings);
      });
      void window.desktop.settings.get().then(
        settings => {
          if (active && !pushed) listener(settings);
        },
        error => log('settings.get invoke failed', error)
      );
      return () => {
        active = false;
        off();
      };
    },
  },
  // Native action surface over window.desktop.capabilities. The
  // read/prompt methods return main's result; the fire-and-forget actions
  // (exportLogs / openSystemSettings) swallow the only reachable rejection
  // (unknown-sender, impossible from this adapter). resetApp relaunches main so
  // its invoke never resolves — swallow it too.
  checkForUpdates: () => window.desktop.capabilities.checkForUpdates(),
  getUpdateState: () => window.desktop.capabilities.getUpdateState(),
  onUpdateState: listener => window.desktop.capabilities.onUpdateState(listener),
  restartToUpdate: () =>
    window.desktop.capabilities
      .restartToUpdate()
      .catch(error => log('capabilities.restartToUpdate invoke failed', error)),
  dismissUpdatePrompt: () =>
    window.desktop.capabilities
      .dismissUpdatePrompt()
      .catch(error => log('capabilities.dismissUpdatePrompt invoke failed', error)),
  exportLogs: () =>
    window.desktop.capabilities
      .exportLogs()
      .catch(error => log('capabilities.exportLogs invoke failed', error)),
  // The floating note: fire-and-forget — the float window
  // opening is the feedback; preload's float.open already swallows the invoke.
  openFloatingNote: noteId => {
    window.desktop.float.open(noteId);
    return Promise.resolve();
  },
  restartApp: () =>
    window.desktop.capabilities
      .restartApp()
      .catch(error => log('capabilities.restartApp invoke failed', error)),
  resetApp: () => {
    // Main resets telemetry identity with the rest of the device state.
    return window.desktop.capabilities
      .resetApp()
      .catch(error => log('capabilities.resetApp invoke failed', error));
  },
  getPermissionStatus: () => window.desktop.capabilities.getPermissionStatus(),
  requestPermission: kind => window.desktop.capabilities.requestPermission({ kind }),
  openSystemSettings: kind =>
    window.desktop.capabilities
      .openSystemSettings({ kind })
      .catch(error => log('capabilities.openSystemSettings invoke failed', error)),
  getAppleCalendarStatus: () => window.desktop.capabilities.getAppleCalendarStatus(),
  enableAppleCalendar: () => window.desktop.capabilities.enableAppleCalendar(),
  refreshAppleCalendar: () => window.desktop.capabilities.refreshAppleCalendar(),
  // Local whisper model manager over window.desktop.models.
  // The verbs are fire-and-forget (every outcome rides the next snapshot).
  // `subscribe` SEEDS from getState: a renderer reload (Cmd+R) recreates the
  // preload push-buffer empty and main pushes only on a state CHANGE, so a
  // subscription alone would leave a reloaded screen blank until the next
  // change (the same lesson as mount.tsx's UpdatePromptOverlay). The pull is
  // dropped once any push has landed — a push is always at least as fresh.
  localModels: {
    getState: () => window.desktop.models.getState(),
    download: modelId =>
      window.desktop.models
        .download({ modelId })
        .catch(error => log('models.download invoke failed', error)),
    cancelDownload: modelId =>
      window.desktop.models
        .cancelDownload({ modelId })
        .catch(error => log('models.cancelDownload invoke failed', error)),
    delete: modelId =>
      window.desktop.models
        .delete({ modelId })
        .catch(error => log('models.delete invoke failed', error)),
    subscribe: listener => {
      let active = true;
      let pushed = false;
      const off = window.desktop.models.onStateChanged(state => {
        pushed = true;
        listener(state);
      });
      void window.desktop.models.getState().then(
        state => {
          if (active && !pushed) listener(state);
        },
        error => log('models.getState invoke failed', error)
      );
      return () => {
        active = false;
        off();
      };
    },
  },
  // The BYOK transcription key: set crosses the key once into main's
  // secure store; has answers a boolean (a failed invoke reads as "no key").
  transcriptionByok: {
    setKey: (key, baseUrl) =>
      window.desktop.capabilities
        .setTranscriptionByokKey({ key, baseUrl })
        .catch(error => log('capabilities.setTranscriptionByokKey invoke failed', error)),
    clearKey: () =>
      window.desktop.capabilities
        .clearTranscriptionByokKey()
        .catch(error => log('capabilities.clearTranscriptionByokKey invoke failed', error)),
    hasKey: () =>
      window.desktop.capabilities.hasTranscriptionByokKey().catch(error => {
        log('capabilities.hasTranscriptionByokKey invoke failed', error);
        return false;
      }),
  },
  // The AI provider keys + catalogue: one secure-store slot per provider;
  // a failed invoke reads as "no key" / an empty catalogue with a reason.
  aiProvider: {
    setKey: (provider, key) =>
      window.desktop.capabilities
        .setAiProviderKey({ provider, key })
        .catch(error => log('capabilities.setAiProviderKey invoke failed', error)),
    clearKey: provider =>
      window.desktop.capabilities
        .clearAiProviderKey({ provider })
        .catch(error => log('capabilities.clearAiProviderKey invoke failed', error)),
    hasKey: provider =>
      window.desktop.capabilities.hasAiProviderKey({ provider }).catch(error => {
        log('capabilities.hasAiProviderKey invoke failed', error);
        return false;
      }),
    listModels: (provider, force) =>
      window.desktop.capabilities
        .listAiModels({ provider, ...(force ? { force } : {}) })
        .catch(error => {
          log('capabilities.listAiModels invoke failed', error);
          return { models: [], error: 'network' as const };
        }),
  },
});

// Local mode's synthetic session: the workspace is
// accountless in main, but the shared renderer stack requires a signed-in
// SessionView to function (SyncStoreProvider bails without an activeSub). The
// static view is built from the SAME constants LocalBackendLive serves on
// /apps/v1/me/organizations — activeOrgId MUST equal that org row's orgId or
// useEnsureActiveOrg fires a doomed auth:switchOrg against main. No
// sessionKey (there is no platform login), and every auth action is a no-op:
// nothing to sign in/out of, no org/account to switch, no collab bearer
// (local note bodies ride the collab:open log lane, not the WSS).
const LOCAL_SESSION_VIEW: SessionView = {
  state: 'signed-in',
  accounts: [
    {
      sub: LOCAL_WORKSPACE.sub,
      email: LOCAL_WORKSPACE.email,
      name: LOCAL_WORKSPACE.name,
      activeOrgId: LOCAL_WORKSPACE.orgId,
    },
  ],
  activeSub: LOCAL_WORKSPACE.sub,
};

function createLocalAuthPort(): AuthPort {
  return {
    getSession: () => LOCAL_SESSION_VIEW,
    // The view never changes — no listener will ever fire.
    onSessionChanged: () => () => {},
    signIn: () => Promise.resolve(),
    addAccount: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
    switchAccount: () => {},
    switchOrg: () => {},
    getToken: () => Promise.resolve(null),
    getTokenForSession: () => Promise.resolve(null),
  };
}

function createAuthPort(): AuthPort {
  let current: SessionView = { state: 'signed-out', accounts: [] };
  const listeners = new Set<(view: SessionView) => void>();
  const publish = (view: SessionView): void => {
    current = view;
    for (const listener of [...listeners]) listener(view);
  };
  // The preload session buffer is multi-subscriber and replays the LATEST view
  // to a late subscriber immediately (the gate subscribed first), so `current`
  // seeds synchronously here when an account already exists (restart-restore).
  window.desktop.auth.onSessionChanged(view => publish(view));
  void window.desktop.auth.getSession().then(publish, () => {});
  return {
    getSession: () => current,
    onSessionChanged: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    signIn: () => window.desktop.auth.signIn().then(() => {}),
    // Desktop's sign-in is already account-additive — main's PKCE dance runs in
    // the system browser and appends to the account store, so there's no session
    // cookie to clear the way web's addAccount has to.
    addAccount: () => window.desktop.auth.signIn().then(() => {}),
    signOut: () => window.desktop.auth.signOut(),
    // Fire-and-forget re-scope: main validates the id against the
    // verified session, mutates its active account/org, and re-broadcasts the
    // session over auth:sessionChanged — which flows back here via the
    // onSessionChanged buffer above (new activeOrgId/activeSub), rebuilds main's
    // SignedInRuntime, and drives app-client's OrgScopedCacheReset. The port is
    // synchronous void; the invoke promise is swallowed (only unknown-sender /
    // malformed-payload can reject — impossible from this adapter's calls).
    switchAccount: sub => {
      window.desktop.auth
        .switchAccount({ sub })
        .catch(error => log('switchAccount invoke failed', error));
    },
    switchOrg: orgId => {
      window.desktop.auth
        .switchOrg({ orgId })
        .catch(error => log('switchOrg invoke failed', error));
    },
    // The note-collab WSS bearer is the one sanctioned full-token crossing. Main
    // resolves the current session's guarded id_token per (re)connect
    // (use-note-collab's token callback), or null when signed-out/stale. The
    // renderer never persists it and never learns the refresh/access token.
    getToken: () => window.desktop.auth.getCollabToken(),
    getTokenForSession: async (expectedSessionKey, expectedOrgId) => {
      const ownsContext = (): boolean => {
        const activeSessionKey = current.activeSessionKey ?? current.activeSub ?? null;
        const active = current.accounts.find(
          account => (account.sessionKey ?? account.sub) === activeSessionKey
        );
        return (
          activeSessionKey === expectedSessionKey &&
          (expectedOrgId === undefined || (active?.activeOrgId ?? null) === expectedOrgId)
        );
      };
      if (!ownsContext()) return null;
      const token = await window.desktop.auth.getCollabToken();
      return token && ownsContext() ? token : null;
    },
  };
}

export interface DesktopPorts {
  readonly appPorts: AppPorts;
  readonly env: EnvPort;
  readonly transport: TransportPort;
  readonly askFetch: AskFetch;
}

export function createDesktopPorts(desktopEnv: DesktopEnvDescriptor): DesktopPorts {
  const env = createEnvPort(desktopEnv);
  const appPorts: AppPorts = {
    navigation: navigationAdapter,
    env,
    auth: desktopEnv.appMode === 'local' ? createLocalAuthPort() : createAuthPort(),
    assets: assetPort,
    external: createExternalPort(desktopEnv),
    desktopCapabilities: createDesktopCapabilityPort(desktopEnv.appMode),
    analytics: desktopAnalyticsPort,
    recording: recordingPort,
  };
  return { appPorts, env, transport: transportPort, askFetch };
}
