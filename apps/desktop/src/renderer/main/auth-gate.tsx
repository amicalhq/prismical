/**
 * The desktop sign-in gate — the only pre-auth UI.
 *
 * Sign-in itself is unchanged and still belongs to the browser: this screen's
 * buttons hand off to main's PKCE flow (`auth:signIn`), the system browser
 * shows the hosted login app, and the callback returns on the `prismical://`
 * deep link. No credential ever enters this window, so the security rule
 * ("tokens never cross into the renderer") is untouched — the renderer still
 * knows only the sanitized SessionView.
 *
 * What changed is the LOOK. The gate used to be plain DOM with an injected
 * <style> block and a lone "Sign in" button; it now renders the same card the
 * hosted login page does — logo, "Welcome to Prismical", "AI note taker", the
 * bordered/shadowed card — built from the shared @prismical/app-ui primitives
 * so the app and the page it hands off to read as one product.
 *
 * Render modes (container data-mode, asserted by the e2e suite):
 * - 'gate'    — signed out: the branded card with a single Prismical sign-in.
 * - 'pending' — signing-in with no active account: the browser dance is under
 *               way. Retry re-invokes signIn; FLOW_ALREADY_PENDING is the
 *               normal answer while one attempt is parked, so it surfaces as a
 *               gentle note, never an error.
 * - 'session' — an active account exists: the minimal signed-in placeholder
 *               (email + sign out + offline badge) that the product shell then
 *               paints over. refreshing/offline ARE a signed-in session with
 *               stale tokens — they render a connectivity affordance,
 *               not the gate.
 *
 * Nothing here writes to localStorage or sessionStorage: the auth sentinel spec
 * asserts renderer storage stays empty/allowlisted.
 */
import {
  createRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { createRoot } from 'react-dom/client';
import type { i18n, TFunction } from 'i18next';
import { I18nextProvider, useTranslation } from 'react-i18next';
import type { SessionAccount, SessionView } from '@prismical/desktop-contracts';
import { Button } from '@prismical/app-ui/ui/button';
import { ShineBorder } from '@prismical/app-ui/ui/shine-border';
import { resetAnalyticsIdentity } from './app/analytics/posthog';
import { GateCard } from './gate-card';
import './app/globals.css';

type RenderMode = 'gate' | 'pending' | 'session';

interface Notice {
  readonly kind: 'info' | 'error';
  readonly text: string;
}

/** Human messages for flow-start failure codes (signInResultSchema). */
const noticeForFailure = (code: string, t: TFunction): Notice => {
  switch (code) {
    case 'NOT_CONFIGURED':
      // A setup problem with this build, not a user error.
      return {
        kind: 'error',
        text: t('desktop.auth.notConfigured'),
      };
    case 'FLOW_ALREADY_PENDING':
      return {
        kind: 'info',
        text: t('desktop.auth.pending'),
      };
    case 'BROWSER_LAUNCH_FAILED':
      return { kind: 'error', text: t('desktop.auth.browserLaunchFailed') };
    default:
      return { kind: 'error', text: t('desktop.auth.signInFailed') };
  }
};

const activeAccount = (view: SessionView): SessionAccount | undefined =>
  view.activeSub === undefined
    ? undefined
    : view.accounts.find(account => account.sub === view.activeSub);

const deriveMode = (view: SessionView, dismissedPending: boolean): RenderMode => {
  if (view.state !== 'signed-out' && activeAccount(view) !== undefined) return 'session';
  if (view.state === 'signing-in' && !dismissedPending) return 'pending';
  return 'gate';
};

function NoticeText({ notice }: { notice: Notice }) {
  return (
    <p
      data-testid="auth-notice"
      data-kind={notice.kind}
      className={
        notice.kind === 'error'
          ? 'text-destructive text-sm leading-snug'
          : 'text-muted-foreground text-sm leading-snug'
      }
    >
      {notice.text}
    </p>
  );
}

function AuthGate({ ref }: { ref: Ref<Pick<AuthGateHandle, 'startSignIn'>> }) {
  const { t } = useTranslation();
  const [view, setView] = useState<SessionView | null>(null);
  const [dismissedPending, setDismissedPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  // The synchronous half of `busy` — see startSignIn for why state alone is not
  // a re-entrancy guard. Always cleared alongside setBusy(false).
  const busyRef = useRef(false);

  // Subscribe FIRST (the preload buffer replays pre-subscription pushes), then
  // seed from getSession — but never let a stale snapshot overwrite a push that
  // already arrived.
  useEffect(() => {
    let sawPush = false;
    // The last view this effect applied. A ref-like local, NOT the `view`
    // state: the "did the gate state change?" comparison drives two OTHER
    // setStates, and doing that inside a setView updater would make the updater
    // impure — React may call it twice (StrictMode) or discard its result.
    let applied: SessionView | null = null;
    const apply = (next: SessionView): void => {
      // A main-side gate transition invalidates the last flow-start notice; a
      // locally dismissed pending surface resets once the flow settles.
      if (applied !== null && applied.state !== next.state) setNotice(null);
      if (next.state !== 'signing-in') setDismissedPending(false);
      applied = next;
      setView(next);
    };
    const off = window.desktop.auth.onSessionChanged(next => {
      sawPush = true;
      apply(next);
    });
    void window.desktop.auth.getSession().then(
      initial => {
        if (!sawPush) apply(initial);
      },
      () => {
        // The membrane refused us (should be impossible for the main window);
        // stay blank rather than render invented state.
      }
    );
    return off;
  }, []);

  const startSignIn = useCallback((): void => {
    // Guarded on the ref, not the `busy` state: state is a render-time value,
    // so `setBusy(true)` does not close the window for a second call dispatched
    // in the SAME task — both would pass `if (busy)` and fire two PKCE attempts
    // (the second answered FLOW_ALREADY_PENDING). The plain-DOM gate this
    // replaced mutated a local synchronously and had no such window; `busy`
    // stays only to drive `disabled`.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void window.desktop.auth.signIn().then(
      result => {
        busyRef.current = false;
        setBusy(false);
        if (result.ok) {
          // Flow started; the gate moves via the sessionChanged push.
          setNotice(null);
          setDismissedPending(false);
          return;
        }
        setNotice(noticeForFailure(result.code, t));
        // Normal while an attempt is parked — back onto the pending surface
        // with a gentle note rather than an error.
        if (result.code === 'FLOW_ALREADY_PENDING') setDismissedPending(false);
      },
      () => {
        busyRef.current = false;
        setBusy(false);
        setNotice(noticeForFailure('INTERNAL', t));
      }
    );
  }, [busy, t]);

  useImperativeHandle(ref, () => ({ startSignIn }), [startSignIn]);

  const signOut = useCallback((): void => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void window.desktop.auth.signOut().then(
      () => {
        // The gate moves via the sessionChanged push.
        busyRef.current = false;
        setBusy(false);
      },
      () => {
        busyRef.current = false;
        setBusy(false);
        setNotice({ kind: 'error', text: t('desktop.auth.signOutFailed') });
      }
    );
  }, [busy, t]);

  // null until main answers the first getSession. The CARD waits on that (an
  // invented signed-out shell would flash the sign-in surface at an already
  // signed-in user on every launch), but the backdrop and the drag strip below
  // must NOT — see the render for why.
  const mode = view === null ? null : deriveMode(view, dismissedPending);

  const renderGate = (): ReactNode => (
    <GateCard>
      <div className="grid gap-3 text-center">
        <div className="relative rounded-md">
          <Button
            type="button"
            className="w-full"
            data-testid="auth-sign-in"
            disabled={busy}
            onClick={startSignIn}
          >
            {t('desktop.modeChooser.cloud.choose')}
          </Button>
          <ShineBorder shineColor={['#6366f1', '#a5b4fc', '#4f46e5']} borderWidth={2} />
        </div>
        {/* The way back to on-device mode for a user who chose the account
            path and never signed in: the mode switch lives in
            Settings, which only exists behind this gate. The switch is the
            destructive reset — signed out, nothing of theirs is at stake. */}
        <Button
          type="button"
          variant="link"
          data-testid="auth-use-locally"
          disabled={busy}
          onClick={() => {
            resetAnalyticsIdentity();
            void window.desktop.capabilities.resetApp({ mode: 'local' }).catch(() => {});
          }}
          className="text-muted-foreground hover:text-foreground justify-self-center text-xs font-normal"
        >
          {t('desktop.modeChooser.local.choose')}
        </Button>
        {notice === null ? null : <NoticeText notice={notice} />}
      </div>
    </GateCard>
  );

  const renderPending = (): ReactNode => (
    <GateCard testId="auth-pending">
      <div className="grid gap-3 text-center">
        <p className="text-sm font-medium">{t('desktop.auth.completeInBrowser')}</p>
        <p className="text-muted-foreground text-sm leading-snug">
          {t('desktop.auth.finishInBrowser')}
        </p>
        {notice === null ? null : <NoticeText notice={notice} />}
        <div className="flex justify-center gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            data-testid="auth-retry"
            disabled={busy}
            onClick={startSignIn}
          >
            {t('desktop.auth.tryAgain')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            data-testid="auth-cancel"
            disabled={busy}
            onClick={() => {
              // Renderer-local dismissal only: the parked attempt in main
              // expires on its own; signing in again resumes or restarts it.
              setDismissedPending(true);
              setNotice(null);
            }}
          >
            {t('desktop.auth.cancel')}
          </Button>
        </div>
      </div>
    </GateCard>
  );

  const renderSession = (current: SessionView): ReactNode => (
    <GateCard testId="auth-session">
      <div className="grid gap-3 text-center">
        <p className="text-muted-foreground text-sm">{t('desktop.auth.signedInAs')}</p>
        <div className="font-medium" data-testid="auth-account-email">
          {activeAccount(current)?.email ?? ''}
        </div>
        {current.state === 'offline' ? (
          <span
            data-testid="auth-offline"
            className="text-muted-foreground mx-auto rounded-full border px-3 py-1 text-xs font-medium"
          >
            {t('desktop.auth.offline')}
          </span>
        ) : null}
        {notice === null ? null : <NoticeText notice={notice} />}
        <Button
          type="button"
          variant="outline"
          className="mx-auto"
          data-testid="auth-sign-out"
          disabled={busy}
          onClick={signOut}
        >
          {t('desktop.auth.signOut')}
        </Button>
      </div>
    </GateCard>
  );

  // The `auth-gate` class is a STYLE hook, not decoration: globals.css zeroes
  // this element's opacity under macOS vibrancy once the shell mounts
  // (`html.vibrancy:has([data-testid="desktop-shell"]) .auth-gate[data-mode="session"]`),
  // because the frosted shell is deliberately transparent and would otherwise
  // show the signed-in placeholder through it. Drop the class and the frost
  // silently goes flat.
  // The backdrop and the drag strip render UNCONDITIONALLY — only the card
  // waits on the first session view. Returning null until then would leave the
  // window as a bare <body> for one IPC round trip, which on darwin is a
  // transparent vibrancy pane (globals.css makes html/body see-through so the
  // NSVisualEffectView shows) that ALSO cannot be dragged, because the strip
  // would not exist yet. The plain-DOM gate appended both before any IPC; this
  // preserves that.
  //
  // `data-mode` / `data-gate-state` stay absent until the view arrives, exactly
  // as the old gate's render() left them unset — the e2e specs poll for them.
  return (
    <div
      data-testid="auth-gate"
      {...(mode === null ? {} : { 'data-mode': mode })}
      {...(view === null ? {} : { 'data-gate-state': view.state })}
      className="auth-gate bg-background text-foreground fixed inset-0 flex justify-center overflow-y-auto px-4 py-10"
    >
      {/* Frameless-window drag strip: pre-auth there is no shell header to drag
          by, so the gate carries its own. Chromium computes draggable regions
          from app-region declarations alone — stacking never subtracts — so it
          must leave the layout entirely once the shell paints over the gate, or
          it would swallow clicks in the top strip forever. The card declares
          no-drag so it stays clickable wherever the two overlap. */}
      {mode === 'session' ? null : <div className="auth-gate-drag" />}
      {/* `my-auto` rather than the container's `items-center`: auto margins only
          consume POSITIVE free space, so the card still centres when it fits but
          stays fully scrollable when it doesn't. Centring via `items-center`
          pushes overflow above the scroll origin, where `overflow-y-auto` cannot
          reach it — the logo and heading would be unreachably clipped. */}
      <div className="auth-gate-card my-auto flex w-full max-w-sm flex-col items-center">
        {view === null || mode === null
          ? null
          : mode === 'gate'
            ? renderGate()
            : mode === 'pending'
              ? renderPending()
              : renderSession(view)}
      </div>
    </div>
  );
}

export interface AuthGateHandle {
  /** Start the browser flow directly after the first-run cloud choice. */
  readonly startSignIn: () => void;
  /**
   * `inert` makes the gate non-interactive AND hidden from assistive tech
   * while the first-run chooser paints over it: without it
   * the gate's sign-in button is the first tabbable element in the document,
   * and Tab + Enter would start an OAuth flow under the chooser.
   */
  readonly setInert: (inert: boolean) => void;
}

export const mountAuthGate = (
  root: HTMLElement,
  instance: i18n,
  options: { readonly inert?: boolean } = {}
): AuthGateHandle => {
  const gateRef = createRef<Pick<AuthGateHandle, 'startSignIn'>>();
  const container = document.createElement('div');
  if (options.inert) container.setAttribute('inert', '');
  root.append(container);
  createRoot(container).render(
    <I18nextProvider i18n={instance}>
      <AuthGate ref={gateRef} />
    </I18nextProvider>
  );
  return {
    startSignIn: () => gateRef.current?.startSignIn(),
    setInert: inert => {
      if (inert) container.setAttribute('inert', '');
      else container.removeAttribute('inert');
    },
  };
};
