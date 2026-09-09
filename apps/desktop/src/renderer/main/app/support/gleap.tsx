import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { MessageCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSessionView } from '@prismical/app-client';
import { Tooltip, TooltipContent, TooltipTrigger } from '@prismical/app-ui/ui/tooltip';
import { useDesktopEnv } from '../desktop-env';
import { getPlanIdentity, subscribePlanIdentity } from '../analytics/plan-identity';
import { chatOwnerKey, createChatIdentitySync } from './gleap-identity';

type GleapSdk = typeof import('gleap').default;
const SupportContext = createContext<GleapSdk | null>(null);

/** One support session in the main renderer, including the cloud sign-in screen. */
export function GleapProvider({ children }: { children: ReactNode }) {
  const { gleap, appMode, appModeChosen, appVersion, platform, applicationLocale } = useDesktopEnv();
  const session = useSessionView();
  const account = session.accounts.find(account => account.sub === session.activeSub);
  const [sdk, setSdk] = useState<GleapSdk | null>(null);
  const [identifiedIdentity, setIdentifiedIdentity] = useState<string>();
  const identitySync = useRef<ReturnType<typeof createChatIdentitySync> | null>(null);
  const sub = account?.sub;
  const name = account?.name;
  const email = account?.email;
  const orgId = account?.activeOrgId;
  const planIdentity = useSyncExternalStore(subscribePlanIdentity, getPlanIdentity);
  const planExternalId = planIdentity && planIdentity.accountId === sub && planIdentity.orgId === orgId
    ? planIdentity.planExternalId : null;
  const identityKey = chatOwnerKey(sub ? { userId: sub, orgId, planExternalId } : null);
  const enabled = appMode === 'cloud' && appModeChosen && !window.location.hash.startsWith('#/float');
  const key = gleap?.key;
  const nonce = gleap?.cspNonce;

  useEffect(() => {
    if (!enabled || !key || !nonce) return;
    let disposed = false;
    let loaded: GleapSdk | undefined;
    // Import only inside the gate: importing the SDK itself installs browser hooks.
    void import('gleap').then(({ default: Gleap }) => {
      if (disposed) return;
      loaded = Gleap;
      Gleap.setCSPNonce(nonce);
      Gleap.setDisablePageTracking(true);
      Gleap.disableConsoleLogOverwrite();
      Gleap.setMaxNetworkRequests(0);
      Gleap.setNetworkLogsBlacklist(['']);
      // Dashboard controls whether replays run. Keep app content out even if enabled there.
      Gleap.setReplayOptions({ blockSelector: 'body', maskAllInputs: true, maskTextSelector: '*' });
      Gleap.setLanguage(applicationLocale);
      Gleap.setAppVersionCode(appVersion);
      Gleap.attachCustomData({ appVersion, platform });
      Gleap.setUrlHandler(url => window.open(url, '_blank', 'noopener,noreferrer'));
      Gleap.showFeedbackButton(false);
      // The separate chatbar resurfaces on close and can reopen the messenger in Electron.
      Gleap.hideAiChatbar();
      Gleap.on('initialized', () => {
        if (!disposed) setSdk(() => Gleap);
      });
      Gleap.initialize(key);
    }).catch(() => {
      // Support is optional; the sidebar retains its email link if loading fails.
      loaded?.destroy();
    });
    return () => {
      disposed = true;
      loaded?.destroy();
      setSdk(null);
    };
  }, [enabled, key, nonce, applicationLocale, appVersion, platform]);

  useEffect(() => {
    if (!sdk) return;
    sdk.close();
    sdk.showFeedbackButton(false);
  }, [sdk, identityKey]);

  useEffect(() => {
    if (!sdk) {
      identitySync.current?.suspend();
      return;
    }
    // Keep the serializer across SDK reinitialization so a late request cannot
    // overwrite the identity applied by the next lifecycle.
    const sync = identitySync.current ??= createChatIdentitySync(sdk, setIdentifiedIdentity);
    const reconcile = () => sync.setIdentity(sub ? { userId: sub, orgId, name, email, planExternalId } : null);
    reconcile();
    window.addEventListener('online', reconcile);
    return () => window.removeEventListener('online', reconcile);
  }, [sdk, sub, orgId, name, email, planExternalId]);
  useEffect(() => () => identitySync.current?.suspend(), []);

  useEffect(() => {
    // The sign-in screen has no sidebar, so it uses Gleap's own launcher.
    sdk?.showFeedbackButton(identifiedIdentity === identityKey && !sub);
  }, [sdk, identifiedIdentity, identityKey, sub]);

  const readySdk = enabled && identifiedIdentity === identityKey ? sdk : null;
  return <SupportContext.Provider value={readySdk}>{children}</SupportContext.Provider>;
}

/** Undefined leaves the shared sidebar's email fallback in place. */
export function useGleapSupportAction(): ReactNode {
  const sdk = useContext(SupportContext);
  const { t } = useTranslation();
  if (!sdk) return undefined;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={t('navigation.secondary.chat')}
          onClick={event => {
            const bottom = Math.max(20, window.innerHeight - event.currentTarget.getBoundingClientRect().top + 8);
            document.documentElement.style.setProperty('--support-chat-bottom', `${bottom}px`);
            sdk.open();
          }}
          className="flex size-7 items-center justify-center rounded-md text-sidebar-foreground-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-hidden"
        >
          <MessageCircle className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{t('navigation.secondary.chat')}</TooltipContent>
    </Tooltip>
  );
}
