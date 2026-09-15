import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  forwardRef,
  type HTMLAttributes,
  type Ref,
  type ReactNode,
} from 'react';
import { MessageCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSessionView } from '@prismical/app-client';
import { useSidebar } from '@prismical/app-ui/ui/sidebar';
import { toast } from '@prismical/app-ui/ui/sonner';
import { useLauncherClearance } from './launcher-clearance';
import { useDesktopEnv } from '../desktop-env';
import { getPlanIdentity, subscribePlanIdentity } from '../analytics/plan-identity';
import { chatOwnerKey, createChatIdentitySync } from './gleap-identity';

type GleapSdk = typeof import('gleap').default;
const SupportContext = createContext<GleapSdk | null>(null);

/** One support session in the main renderer, including the cloud sign-in screen. */
export function GleapProvider({ children }: { children: ReactNode }) {
  const { gleap, appMode, appModeChosen, appVersion, platform, applicationLocale } =
    useDesktopEnv();
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
  const planExternalId =
    planIdentity && planIdentity.accountId === sub && planIdentity.orgId === orgId
      ? planIdentity.planExternalId
      : null;
  const identityKey = chatOwnerKey(sub ? { userId: sub, orgId, planExternalId } : null);
  const enabled =
    appMode === 'cloud' && appModeChosen && !window.location.hash.startsWith('#/float');
  const key = gleap?.key;
  const nonce = gleap?.cspNonce;
  useLauncherClearance(enabled && !!key && !!nonce);

  useEffect(() => {
    if (!enabled || !key || !nonce) return;
    let disposed = false;
    let loaded: GleapSdk | undefined;
    // Import only inside the gate: importing the SDK itself installs browser hooks.
    void import('gleap')
      .then(({ default: Gleap }) => {
        if (disposed) return;
        loaded = Gleap;
        Gleap.setCSPNonce(nonce);
        Gleap.setDisablePageTracking(true);
        Gleap.disableConsoleLogOverwrite();
        Gleap.setMaxNetworkRequests(0);
        Gleap.setNetworkLogsBlacklist(['']);
        // Dashboard controls whether replays run. Keep app content out even if enabled there.
        Gleap.setReplayOptions({
          blockSelector: 'body',
          maskAllInputs: true,
          maskTextSelector: '*',
        });
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
      })
      .catch(() => {
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
    const sync = (identitySync.current ??= createChatIdentitySync(sdk, setIdentifiedIdentity));
    const reconcile = () =>
      sync.setIdentity(sub ? { userId: sub, orgId, name, email, planExternalId } : null);
    reconcile();
    window.addEventListener('online', reconcile);
    return () => window.removeEventListener('online', reconcile);
  }, [sdk, sub, orgId, name, email, planExternalId]);
  useEffect(() => () => identitySync.current?.suspend(), []);

  useEffect(() => {
    sdk?.showFeedbackButton(identifiedIdentity === identityKey);
  }, [sdk, identifiedIdentity, identityKey]);

  const readySdk = enabled && identifiedIdentity === identityKey ? sdk : null;
  return <SupportContext.Provider value={readySdk}>{children}</SupportContext.Provider>;
}

/** Undefined leaves the shared sidebar's email fallback in place. */
export function useGleapSupportAction(): ReactNode {
  const sdk = useContext(SupportContext);
  const [openFailed, setOpenFailed] = useState(false);
  if (!sdk) return undefined;
  return (
    <GleapSupportTrigger
      sdk={sdk}
      openFailed={openFailed}
      onOpenFailed={() => setOpenFailed(true)}
    />
  );
}

const GleapSupportTrigger = forwardRef<
  HTMLElement,
  HTMLAttributes<HTMLElement> & { sdk: GleapSdk; openFailed: boolean; onOpenFailed: () => void }
>(function GleapSupportTrigger({ sdk, openFailed, onOpenFailed, onClick, ...rest }, ref) {
  const { t } = useTranslation();
  const { setOpenMobile } = useSidebar();
  const content = (
    <>
      <MessageCircle className="size-4" />
      <span>{t('navigation.secondary.chat')}</span>
    </>
  );
  if (openFailed) {
    return (
      <a
        {...rest}
        ref={ref as Ref<HTMLAnchorElement>}
        href="mailto:help@prismical.ai"
        onClick={onClick}
      >
        {content}
      </a>
    );
  }
  return (
    <button
      {...rest}
      ref={ref as Ref<HTMLButtonElement>}
      type="button"
      aria-label={t('navigation.secondary.chat')}
      onClick={event => {
        onClick?.(event);
        setOpenMobile(false);
        try {
          sdk.open();
        } catch {
          onOpenFailed();
          toast.error(t('common.errors.couldNotLoad'));
        }
      }}
    >
      {content}
    </button>
  );
});
