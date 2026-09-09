'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Gift, Megaphone, Star, Sparkles, Heart, X, ArrowUpRight } from 'lucide-react';
import {
  useCta,
  useActiveAccountId,
  useActiveSessionKey,
  useActiveOrgId,
  usePorts,
  EVENTS,
  apiClient,
  ME_PREFIX,
  getAuthToken,
  getClientTransport,
  activeOrgIdOf,
  type Cta,
} from '@prismical/app-client';
import { useSidebar } from '../ui/sidebar';

const icons = { gift: Gift, megaphone: Megaphone, star: Star, sparkles: Sparkles, heart: Heart };

export const campaignGradients = {
  indigo: { label: 'Indigo–Purple', backgroundImage: 'linear-gradient(135deg, #818cf8, #a855f7)' },
  purple: { label: 'Purple–Pink', backgroundImage: 'linear-gradient(135deg, #a78bfa, #ec4899)' },
  pink: { label: 'Pink–Orange', backgroundImage: 'linear-gradient(135deg, #f472b6, #fb923c)' },
  blue_green: { label: 'Blue–Green', backgroundImage: 'linear-gradient(135deg, #60a5fa, #34d399)' },
} as const;
export function campaignGradientStyle(
  preset: keyof typeof campaignGradients | null | undefined,
  text = false
): React.CSSProperties | undefined {
  const gradient = preset ? campaignGradients[preset] : undefined;
  if (!gradient) return undefined;
  return text
    ? {
        backgroundImage: gradient.backgroundImage,
        backgroundClip: 'text',
        WebkitBackgroundClip: 'text',
        color: 'transparent',
        WebkitTextFillColor: 'transparent',
      }
    : { backgroundImage: gradient.backgroundImage, backgroundColor: '#818cf8', color: '#000000' };
}
export function ctaColors(hex: string | null): React.CSSProperties | undefined {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  const channels = [1, 3, 5].map(offset => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  return { backgroundColor: hex, color: luminance > 0.179 ? '#000000' : '#ffffff' };
}

type Controller = {
  cta: Cta | null;
  foreground: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  open: () => void;
  track: (event: string, placement: 'card' | 'sidebar') => void;
};
const Context = React.createContext<Controller | null>(null);

export function CtaProvider({ children }: { children: React.ReactNode }) {
  const session = useActiveSessionKey();
  const orgId = useActiveOrgId();
  return <CtaSession key={`${session}:${orgId}`}>{children}</CtaSession>;
}

function CtaSession({ children }: { children: React.ReactNode }) {
  const { data, refetch, isError } = useCta();
  const userId = useActiveAccountId();
  const { analytics, env, external, auth } = usePorts();
  const [modalOpen, setModalOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [visible, setVisible] = React.useState<string | null>(null);
  const [manual, setManual] = React.useState<string | null>(null);
  const immediateOpen = React.useRef(false);
  const [now, setNow] = React.useState(Date.now);
  const [foreground, setForeground] = React.useState(false);
  const storageKey = `cta-dismissal:${userId}`;
  const [pending, setPending] = React.useState<string | null>(() => {
    try {
      return localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  });
  const pendingRef = React.useRef(pending);
  const cta =
    !isError && data && (!data.expiresAt || Date.parse(data.expiresAt) > now) ? data : null;
  const id = cta?.assignmentId;
  const dismissed = cta?.dismissed || pending === id;
  const campaignId = cta?.id;
  const campaignKey = cta?.campaignKey;
  const automaticCard = cta?.content.card;
  const delaySeconds = cta?.content.delaySeconds ?? 5;
  const track = React.useCallback(
    (event: string, placement: 'card' | 'sidebar') => {
      if (!campaignId || !id) return;
      try {
        analytics.capture(event, {
          campaign_id: campaignId,
          campaign_key: campaignKey,
          assignment_id: id,
          placement,
          platform: env.getEnv().platform,
        });
      } catch {
        /* Optional analytics must never block the CTA action or dismissal. */
      }
    },
    [analytics, campaignId, campaignKey, id, env]
  );

  React.useEffect(() => {
    const check = () =>
      setModalOpen(!!document.querySelector('[role="dialog"][data-state="open"], dialog[open]'));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-state', 'open'],
    });
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    const focus = () => {
      setForeground(document.visibilityState === 'visible');
      void refetch();
    };
    setForeground(document.visibilityState === 'visible');
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [refetch]);

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const current = Date.now();
      setNow(current);
      const remaining = data?.expiresAt ? Date.parse(data.expiresAt) - current : 0;
      if (remaining > 0) timer = setTimeout(update, Math.min(remaining, 2_147_483_647));
    };
    update();
    return () => clearTimeout(timer);
  }, [data?.expiresAt]);

  // Retry failed dismissal writes without showing the card again on this client.
  React.useEffect(() => {
    if (!pending || !userId) return;
    const transport = getClientTransport();
    const token = transport ? null : getAuthToken();
    if (!transport && !token) return;
    const owner = auth.getSession();
    const ownerSessionKey = owner.activeSessionKey ?? owner.activeSub;
    const ownerOrgId = activeOrgIdOf(owner);
    if (!ownerSessionKey || !ownerOrgId) return;
    const stillOwned = () => {
      const current = auth.getSession();
      return current.state !== 'refreshing' &&
        (current.activeSessionKey ?? current.activeSub) === ownerSessionKey &&
        activeOrgIdOf(current) === ownerOrgId;
    };
    let active = true;
    let inflight = false;
    const send = async () => {
      if (!active || inflight || !stillOwned()) return;
      inflight = true;
      try {
        await apiClient.postRaw(
          `${ME_PREFIX}/cta/${encodeURIComponent(pending)}/dismiss`,
          undefined,
          token ? { authToken: token } : undefined
        );
        if (active && stillOwned()) {
          // Wait for the authoritative read before releasing optimistic suppression.
          const refreshed = await refetch();
          const confirmed =
            refreshed.isSuccess &&
            (refreshed.data?.assignmentId !== pending || refreshed.data?.dismissed === true);
          if (active && stillOwned() && confirmed && pendingRef.current === pending) {
            try {
              localStorage.removeItem(storageKey);
            } catch {
              /* unavailable storage */
            }
            setPending(null);
            pendingRef.current = null;
          }
        }
      } catch {
        /* the next retry/focus resumes this user-owned write */
      } finally {
        inflight = false;
      }
    };
    void send();
    const timer = window.setInterval(() => void send(), 15_000);
    window.addEventListener('online', send);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('online', send);
    };
  }, [pending, userId, refetch, storageKey, auth]);

  React.useEffect(() => {
    setVisible(null);
    if (
      !id ||
      !foreground ||
      busy ||
      modalOpen ||
      (manual !== id && (dismissed || !automaticCard))
    ) {
      immediateOpen.current = false;
      return;
    }
    const delay = immediateOpen.current ? 0 : delaySeconds * 1000;
    immediateOpen.current = false;
    const timer = window.setTimeout(() => setVisible(id), delay);
    return () => clearTimeout(timer);
  }, [id, foreground, busy, modalOpen, dismissed, automaticCard, delaySeconds, manual]);

  const shown =
    !!cta && visible === id && foreground && !busy && !modalOpen && (manual === id || !dismissed);
  React.useEffect(() => {
    if (shown) track(EVENTS.CTA_SHOWN, 'card');
  }, [shown, track]);
  const dismiss = () => {
    if (!id) return;
    track(EVENTS.CTA_DISMISSED, 'card');
    setVisible(null);
    setManual(null);
    setPending(id);
    pendingRef.current = id;
    try {
      localStorage.setItem(storageKey, id);
    } catch {
      /* keep in-memory suppression */
    }
  };
  const open = () => {
    if (!cta || busy) return;
    if (cta.content.sidebarAction === 'open_url') {
      track(EVENTS.CTA_CLICKED, 'sidebar');
      external.openExternalUrl(cta.content.action.url);
    } else {
      track(EVENTS.CTA_OPENED, 'sidebar');
      immediateOpen.current = true;
      setManual(cta.assignmentId);
      setVisible(cta.assignmentId);
    }
  };
  return (
    <Context.Provider value={{ cta, busy, foreground, setBusy, open, track }}>
      {children}
      {shown
        ? createPortal(
            <CtaCard
              cta={cta}
              onDismiss={dismiss}
              onAction={() => {
                track(EVENTS.CTA_CLICKED, 'card');
                external.openExternalUrl(cta.content.action.url);
              }}
            />,
            document.body
          )
        : null}
    </Context.Provider>
  );
}

/** The existing recording owner reports its state; no second recording hook is mounted. */
export function useCtaRecordingGuard(busy: boolean) {
  const controller = React.useContext(Context);
  const setBusy = controller?.setBusy;
  React.useLayoutEffect(() => {
    setBusy?.(busy);
    return () => setBusy?.(false);
  }, [busy, setBusy]);
}

export function CtaSidebarButton() {
  const controller = React.useContext(Context);
  const { isMobile, openMobile, state, setOpenMobile } = useSidebar();
  const cta = controller?.cta;
  const visible =
    !!cta?.content.sidebar &&
    !!controller?.foreground &&
    (isMobile ? openMobile : state === 'expanded');
  const track = controller?.track;
  React.useEffect(() => {
    if (visible) track?.(EVENTS.CTA_SHOWN, 'sidebar');
  }, [visible, track]);
  if (!cta?.content.sidebar) return null;
  const Icon = icons[cta.content.icon];
  return (
    <div className="px-2 pb-1">
      <button
        type="button"
        disabled={controller?.busy}
        className="flex w-full items-center gap-2 rounded-lg bg-primary px-3 py-2 text-left text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
        style={
          campaignGradientStyle(cta.content.buttonGradient) ??
          ctaColors(cta.content.buttonColor ?? cta.content.color)
        }
        onClick={() => {
          setOpenMobile(false);
          controller?.open();
        }}
      >
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 break-words">{cta.content.sidebarLabel}</span>
      </button>
    </div>
  );
}

export function CtaCard({
  cta,
  onDismiss,
  onAction,
}: {
  cta: Cta;
  onDismiss: () => void;
  onAction: () => void;
}) {
  const Icon = icons[cta.content.icon];
  const titleId = React.useId();
  return (
    <section
      role="region"
      aria-labelledby={titleId}
      data-testid="cta-card"
      className="fixed z-40 w-[calc(100vw-2rem)] max-w-sm overflow-y-auto rounded-2xl border border-border bg-popover p-5 text-popover-foreground shadow-xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2"
      style={{
        right: 'max(1rem, env(safe-area-inset-right))',
        bottom: 'max(6rem, calc(env(safe-area-inset-bottom) + 1rem))',
        maxHeight: 'calc(100dvh - 9rem)',
      }}
    >
      <button
        type="button"
        aria-label={cta.content.dismissLabel}
        onClick={onDismiss}
        className="absolute right-2 top-2 flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
      >
        <X className="size-4" />
      </button>
      <div
        className="mb-4 flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground"
        style={
          campaignGradientStyle(cta.content.iconGradient) ??
          ctaColors(cta.content.iconColor ?? cta.content.color)
        }
      >
        <Icon className="size-5" aria-hidden="true" />
      </div>
      {cta.content.imageUrl ? (
        <img
          src={cta.content.imageUrl}
          alt=""
          referrerPolicy="no-referrer"
          className="mb-4 max-h-40 w-full rounded-lg object-cover"
        />
      ) : null}
      <h2
        id={titleId}
        style={
          campaignGradientStyle(cta.content.headerGradient, true) ?? {
            color: cta.content.headerColor ?? undefined,
          }
        }
        className="break-words pr-4 text-base font-semibold leading-snug"
      >
        {cta.content.title}
      </h2>
      <p className="mt-2 whitespace-pre-line break-words text-sm leading-relaxed text-muted-foreground">
        {cta.content.body}
      </p>
      <button
        type="button"
        onClick={onAction}
        style={
          campaignGradientStyle(cta.content.buttonGradient) ??
          ctaColors(cta.content.buttonColor ?? cta.content.color)
        }
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {cta.content.action.label}
        <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
      </button>
    </section>
  );
}
