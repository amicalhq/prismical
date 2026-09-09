/**
 * Mounts the shared @prismical/app-ui shell in the desktop renderer, BESIDE the
 * auth gate, behind the mode router.
 *
 * Coexistence with the gate: index.ts runs `mountAuthGate` FIRST in cloud mode
 * (it owns the pre-auth surface, in its own React root), then this. Both
 * subscribe to the SAME preload session buffer (multi-subscriber, built for
 * exactly this) — the gate through its own getSession/onSessionChanged, the
 * shell through the desktop AuthPort. The router (app/mode-router.ts) decides
 * what this root renders: the first-run chooser (over the gate) while no mode
 * was ever chosen; the shell in local mode or once an account is active;
 * NOTHING in cloud mode without an account, so the gate shows. Post-sign-in
 * the shell paints over the gate (fixed, opaque, higher z-index), so the
 * gate's session placeholder + testids stay intact underneath.
 *
 * The env descriptor is resolved from main BEFORE the providers mount, because
 * EnvPort.getEnv() is synchronous and app-client's non-React data lane reads it
 * at request time.
 */
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import { RouterProvider } from '@tanstack/react-router';
import {
  ApiQueryProvider,
  PortsProvider,
  configureAppClient,
  createIndexedDbPersistPlugin,
  useSessionView,
} from '@prismical/app-client';
import { ApplicationI18nProvider } from '@prismical/app-i18n';
import type { OnboardingState } from '@prismical/desktop-contracts';
import { Toaster, toast } from '@prismical/app-ui/ui/sonner';
import { RequiredUpdateGate } from './updater/required-update-gate';
import { UpdatePrompt } from './updater/update-prompt';
import { router } from './router';
import { openNoteLog } from '../collab';
import { createDesktopPorts } from './ports/desktop-ports';
import { bindDesktopWorkflowLifecycle } from './ports/workflow-lifecycle';
import { DesktopEnvProvider, useDesktopEnv } from './desktop-env';
import { GleapProvider } from './support/gleap';
import { PlanIdentityBridge } from './analytics/plan-identity-bridge';
import { OnboardingFlow } from './onboarding/flow';
import { CalendarOnboarding } from './onboarding/calendar';
import { resolveSurface } from './mode-router';
import {
  persistDesktopLocalePreference,
  type DesktopRendererI18nBootstrap,
} from '../application-i18n';
import type {
  AppModeState,
  EnvDescriptor as DesktopEnvDescriptor,
} from '@prismical/desktop-contracts';
import './globals.css';

function ShellOverlay() {
  const { t } = useTranslation();
  const { appMode } = useDesktopEnv();
  // Drain main→renderer navigation pushes onto the hash router. The preload
  // nav buffer holds any push that arrived before this subscription — a
  // cold-start deep link / tray / menu Navigate dispatched while the gate still
  // owned the surface — and replays the backlog the moment the signed-in shell
  // mounts here; live pushes flow straight through. Each {path} is an app href
  // driven onto history exactly like NavigationPort.push (desktop-ports). onPush
  // returns its unsubscribe, so it doubles as the effect cleanup on unmount.
  //
  // Ordering: RouterProvider (below) runs its initial index→/home redirect as an
  // async load on mount. A path pushed during that same commit is clobbered by
  // the late-settling redirect, so chain each push after the router's current
  // load settles — a replayed cold-start deep link then wins the destination.
  useEffect(
    () =>
      window.desktop.nav.onPush(({ path, notice }) => {
        void (router.latestLoadPromise ?? Promise.resolve()).then(() => {
          router.history.push(path);
          if (notice === 'floating-mode-unavailable') {
            toast.info(t('settings.billing.screen.gateFloatingMode'), { id: notice });
          }
        });
      }),
    [t]
  );
  return (
    <div
      data-testid="desktop-shell"
      style={{ position: 'fixed', inset: 0, zIndex: 10, background: 'var(--background)' }}
    >
      {/* The router context carries the mode: cloud-only routes redirect
          home in local mode from `beforeLoad`, so a typed hash or a main-side
          nav push cannot reach a screen the sidebar hides. */}
      <RouterProvider router={router} context={{ appMode }} />
      <Toaster />
    </div>
  );
}

// The float-note window mounts the same providers + router
// but skips the opaque shell overlay chrome: the page stays transparent (the
// FloatNoteView draws its own rounded surface). Its Toaster shows recording
// feedback; UpdatePrompt stays main-window-only. The nav drain still runs — main retargets the float
// via nav pushes (float:open on a live window).
function FloatOverlay() {
  const { appMode } = useDesktopEnv();
  useEffect(
    () =>
      window.desktop.nav.onPush(({ path }) => {
        void (router.latestLoadPromise ?? Promise.resolve()).then(() => router.history.push(path));
      }),
    []
  );
  return (
    <>
      <RouterProvider router={router} context={{ appMode }} />
      <Toaster />
    </>
  );
}

/** True when this renderer is the float-note window (hash set before load). */
export const isFloatWindow = (): boolean => window.location.hash.startsWith('#/float');

/**
 * The mode router renders the surface that app/mode-router.ts names. Local mode
 * is accountless: the auth gate
 * never mounts (index.ts) and the AuthPort serves the static synthetic
 * session, so the shell owns the surface from boot. Cloud without an active
 * account renders NOTHING — the gate root underneath owns the surface. The
 * first-run chooser paints over that gate until a mode is chosen. (The float
 * window is only summonable from a live shell, so its chooser/gate arms are
 * unreachable-transparent fallbacks.)
 */
function DesktopApp({
  onChosen,
  onboarding,
  saveOnboarding,
}: {
  onChosen: () => void;
  onboarding: OnboardingState | null;
  saveOnboarding: (progress: OnboardingState) => Promise<void>;
}) {
  const { appMode, appModeChosen } = useDesktopEnv();
  const session = useSessionView();
  const hasActiveAccount =
    session.activeSub !== undefined &&
    session.accounts.some(account => account.sub === session.activeSub);
  const surface = resolveSurface({ appMode, appModeChosen, hasActiveAccount, onboarding });
  if (surface === 'chooser')
    return isFloatWindow() ? null : (
      <OnboardingFlow progress={onboarding} save={saveOnboarding} onChosen={onChosen} />
    );
  if (surface === 'gate') return null;
  if (surface === 'calendar' && onboarding)
    return isFloatWindow() ? null : (
      <CalendarOnboarding onComplete={() => saveOnboarding({ ...onboarding, step: 'complete' })} />
    );
  return isFloatWindow() ? <FloatOverlay /> : <ShellOverlay />;
}

/**
 * Owns the one piece of renderer-local mode state: whether a mode has been
 * chosen. It starts from main's answer and flips in-process only when the
 * first-run choice EQUALS the boot mode (choosing the other mode relaunches).
 * Analytics stays uninitialised until then — nothing may beacon under a policy
 * the user has not picked yet.
 */
function DesktopRoot({
  desktopEnv,
  appModeState,
  onModeChosen,
  initialOnboarding,
}: {
  desktopEnv: DesktopEnvDescriptor;
  appModeState: AppModeState;
  onModeChosen: () => void;
  initialOnboarding: OnboardingState | null;
}) {
  const [appModeChosen, setAppModeChosen] = useState(appModeState.chosen);
  const [onboarding, setOnboarding] = useState(initialOnboarding);
  const env = useMemo(() => ({ ...desktopEnv, appModeChosen }), [desktopEnv, appModeChosen]);
  return (
    <DesktopEnvProvider value={env}>
      <GleapProvider>
        <RequiredUpdateGate>
          <ApiQueryProvider>
            <PlanIdentityBridge />
            <DesktopApp
              onboarding={onboarding}
              saveOnboarding={async progress => {
                await window.desktop.settings.set({ onboarding: progress });
                setOnboarding(progress);
              }}
              onChosen={() => {
                setAppModeChosen(true);
                onModeChosen();
              }}
            />
          </ApiQueryProvider>
          {!isFloatWindow() && <UpdatePrompt />}
        </RequiredUpdateGate>
      </GleapProvider>
    </DesktopEnvProvider>
  );
}

export interface MountAppShellOptions {
  readonly onboarding?: OnboardingState | null;
  /** The first-run choice resolved in-process (cloud): the gate root takes the surface. */
  readonly onModeChosen?: () => void;
}

export async function mountAppShell(
  root: HTMLElement,
  desktopEnv: DesktopEnvDescriptor,
  i18n: DesktopRendererI18nBootstrap,
  appModeState: AppModeState,
  options: MountAppShellOptions = {}
): Promise<void> {
  const container = document.createElement('div');
  root.append(container);

  const ports = createDesktopPorts(desktopEnv);
  bindDesktopWorkflowLifecycle({
    auth: ports.appPorts.auth,
    workflow: ports.appPorts.workflow!,
    dispose: ports.dispose,
  });
  // Inject env + the transport lanes into the non-React data code (apiClient
  // REST, Ask streaming). React code reads env/ports through the context below.
  // Partition-scoped IndexedDB persistence for the Legend sync store —
  // the instant-warm-boot substrate (each account+org gets its own database).
  // The note-body log lane — main persists/relays each note's Yjs
  // update log; in cloud mode it is a cache riding beside the provider
  // (remote: true), in local mode it IS the collab lane.
  configureAppClient({
    env: ports.env,
    transport: ports.transport,
    askFetch: ports.askFetch,
    syncPersistence: partition => createIndexedDbPersistPlugin(partition),
    noteLog: { open: openNoteLog, remote: desktopEnv.appMode === 'cloud' },
  });

  createRoot(container).render(
    <ApplicationI18nProvider
      instance={i18n.instance}
      initialPreference={i18n.preference}
      systemLocale={desktopEnv.systemLocale}
      applyMode="restart"
      persistPreference={preference =>
        persistDesktopLocalePreference(window.desktop.settings, preference)
      }
      restartApplication={() => ports.appPorts.desktopCapabilities.restartApp()}
      onPersistenceError={() => toast.error(i18n.instance.t('common.errors.localeSave'))}
    >
      <PortsProvider ports={ports.appPorts}>
        <DesktopRoot
          desktopEnv={desktopEnv}
          appModeState={appModeState}
          initialOnboarding={options.onboarding ?? null}
          onModeChosen={() => options.onModeChosen?.()}
        />
      </PortsProvider>
    </ApplicationI18nProvider>
  );
}
