'use client';

import * as React from 'react';
import {
  EVENTS,
  useAccountExperience,
  useActiveOrg,
  useDesktopCapabilities,
  usePathname,
  usePorts,
} from '@prismical/app-client';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { X } from 'lucide-react';
import { OnboardingDownloadButtons } from './download-actions';

/**
 * The player page for the getting-started video. Deliberately the DIRECT embed URL and not the
 * shortened link: a shortened link is served as its own document that frames this one, and a
 * player nested two frames deep cannot deliver its player.js events to this page, cannot be given
 * player parameters from here, and costs an extra document load every time the dialog opens. The
 * shortened link is the right shape for the help menu, where it is an ordinary outbound link.
 *
 * Swapping the video is a one-line change here; the host must stay the same, because the embed is
 * framed and the page's `frame-src` names this host exactly.
 */
const VIDEO_EMBED_URL = 'https://livid.com/embed/gzamRht7O9Gd';
/** The player's origin: both the only postMessage target and the only accepted sender. */
const PLAYER_ORIGIN = 'https://livid.com';

/**
 * One-time welcome dialog: a short getting-started video and the app download links, gated on the
 * `welcomeVideo` feature flag.
 *
 * Shown once to EVERY account that has not seen it - not only new signups - because the video is
 * new to existing accounts too. `welcome.seen` is account-scoped and server-persisted, so
 * one showing covers every device and browser the account uses.
 *
 * Three conditions guard the open, and each exists because `welcome.seen` is spent the moment the
 * dialog opens and is never cleared: an open nobody reads costs the account the dialog for good.
 *  - HOME ONLY. The first authenticated URL can be a shared-note deep link or a settings page
 *    reached from an email, and a modal over someone's note is both worse and unrelated.
 *  - The ACTIVE org, strictly. `useFeatureFlag` falls back to the first org in a stale list when
 *    the active one is not in it yet, and reports itself resolved while doing so - enough to spend
 *    an account-scoped preference on a value the active org never set. `useActiveOrg()` is a strict
 *    lookup that stays null until the list contains the active org, so it declines to answer
 *    instead of answering from the wrong workspace.
 *  - Not while the guided walkthrough is running, whose own dialogs are `/home`-scoped too and
 *    carry download buttons of their own.
 */
export function WelcomeVideoDialog() {
  const { t } = useTranslation();
  const { analytics } = usePorts();
  const [open, setOpen] = React.useState(false);
  const promptCaptured = React.useRef(false);
  const actionCaptured = React.useRef(false);
  const playCaptured = React.useRef(false);
  const completedCaptured = React.useRef(false);
  /** Furthest position reported by the player, so a close can say how much was actually watched. */
  const progress = React.useRef<{ seconds: number; duration: number } | null>(null);
  const frameRef = React.useRef<HTMLIFrameElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  // Destructured so the effect depends on the two values it reads rather than on the hook's
  // freshly-built result object, which changes identity on every render.
  const { data: preferences, update: updatePreferences } = useAccountExperience();
  const activeOrg = useActiveOrg();
  const pathname = usePathname();
  // Desktop is already the app, so it is offered the phone apps rather than all four.
  const downloadHeading = useDesktopCapabilities().has('global-shortcuts')
    ? 'onboarding.getMobileApp'
    : 'onboarding.downloadApps';

  const welcomeEnabled = activeOrg?.features?.welcomeVideo === true;
  const tourEnabled = activeOrg?.features?.userTour === true;

  // No per-account reset of the latches below: `AccountPreferencesProvider` mounts this inside an
  // `AccountExperienceProvider` whose scope is keyed by the session, so switching accounts
  // REMOUNTS this component with fresh refs. A manual reset here would be dead code that reads as
  // though it were load-bearing.

  React.useEffect(() => {
    if (promptCaptured.current) return;
    if (pathname !== '/home') return;
    if (!activeOrg) return;
    if (!welcomeEnabled || tourEnabled) return;
    if (!preferences || preferences.welcome.seen) return;
    // Latched before the write: `update` publishes optimistically, so under StrictMode's double
    // invoke both passes would otherwise see `seen: false` and report the dialog twice.
    promptCaptured.current = true;
    updatePreferences?.({ welcome: { seen: true } });
    setOpen(true);
    analytics.capture(EVENTS.ONBOARDING_PROMPT_VIEWED, { prompt: 'welcome_video' });
  }, [analytics, preferences, updatePreferences, activeOrg, pathname, tourEnabled, welcomeEnabled]);

  /**
   * player.js, the postMessage protocol the player speaks, is the only way to learn whether the
   * video was actually watched: the player is a cross-origin document, so nothing inside it is
   * observable from here otherwise. This is what the direct embed buys - a player nested inside a
   * redirecting link's own document would send these to THAT document instead of this one.
   *
   * Registration has to wait for `ready`; requests sent before it are dropped on the floor. The
   * timer re-registers once in case the player announced itself before this listener attached.
   */
  React.useEffect(() => {
    if (!open) return;
    // The frame is resolved lazily on every use rather than captured here: the dialog's content is
    // portalled, and its children mount AFTER this effect runs, so `frameRef.current` is still null
    // at this point. Capturing it would silently disable the whole listener.
    let registered = false;
    const register = () => {
      const player = frameRef.current?.contentWindow;
      if (registered || !player) return;
      registered = true;
      for (const event of ['play', 'ended', 'timeupdate']) {
        player.postMessage(
          JSON.stringify({
            context: 'player.js',
            version: '2.0',
            method: 'addEventListener',
            value: event,
          }),
          PLAYER_ORIGIN
        );
      }
    };
    const onMessage = (message: MessageEvent) => {
      // Any document may post here. Accept only this player's frame, on its own origin, and treat
      // the payload as untrusted data: a shape check, never anything derived from it as code.
      if (message.origin !== PLAYER_ORIGIN) return;
      if (!frameRef.current || message.source !== frameRef.current.contentWindow) return;
      let payload: unknown = message.data;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch {
          return;
        }
      }
      if (typeof payload !== 'object' || payload === null) return;
      const { context, event, value } = payload as {
        context?: unknown;
        event?: unknown;
        value?: unknown;
      };
      if (context !== 'player.js' || typeof event !== 'string') return;
      if (event === 'ready') return register();
      if (event === 'play' && !playCaptured.current) {
        playCaptured.current = true;
        analytics.capture(EVENTS.ONBOARDING_PROMPT_ACTIONED, {
          prompt: 'welcome_video',
          action: 'video_play',
        });
        return;
      }
      if (event === 'ended' && !completedCaptured.current) {
        completedCaptured.current = true;
        analytics.capture(EVENTS.ONBOARDING_PROMPT_ACTIONED, {
          prompt: 'welcome_video',
          action: 'video_completed',
        });
        return;
      }
      if (event === 'timeupdate') {
        const { seconds, duration } = (value ?? {}) as { seconds?: unknown; duration?: unknown };
        // Furthest reached, not latest: scrubbing backwards must not shrink what was watched.
        if (
          typeof seconds === 'number' &&
          typeof duration === 'number' &&
          duration > 0 &&
          seconds >= (progress.current?.seconds ?? 0)
        )
          progress.current = { seconds, duration };
      }
    };
    window.addEventListener('message', onMessage);
    const retry = setTimeout(register, 2500);
    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(retry);
    };
  }, [open, analytics]);

  const dismiss = React.useCallback(() => {
    if (!actionCaptured.current) {
      const watched = progress.current;
      analytics.capture(EVENTS.ONBOARDING_PROMPT_ACTIONED, {
        prompt: 'welcome_video',
        action: 'dismissed',
        video_played: playCaptured.current,
        // Absent rather than zero when the player never reported a position: "we do not know"
        // and "watched none of it" are different answers, and averaging them together is wrong.
        ...(watched
          ? {
              video_seconds_watched: Math.round(watched.seconds),
              video_percent_watched: Math.min(
                100,
                Math.round((watched.seconds / watched.duration) * 100)
              ),
            }
          : {}),
      });
      actionCaptured.current = true;
    }
    setOpen(false);
  }, [analytics]);

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (next) setOpen(true);
        else dismiss();
      }}
    >
      {/* Wide enough to give the video real size while keeping a margin at every width. Nothing
          scrolls: on a short viewport the 16:9 box shrinks and the player letterboxes, so the
          close control and the download row are always on screen. */}
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 rounded-2xl p-6 sm:max-w-[min(56rem,calc(100%-2rem))]"
        // The shared close is a bare 16px icon. That was fine beside a "Maybe later" button; as the
        // only labelled way out it is below the minimum touch target, so this dialog brings its own.
        showCloseButton={false}
        // Radix autofocuses the first tabbable element, which here is the IFRAME - and a key
        // pressed inside a cross-origin frame never reaches this document, so Escape would
        // silently stop dismissing the dialog the moment it opened. Focus the dialog itself
        // instead: Escape keeps working, and the frame stays in the Tab order for keyboard users.
        onOpenAutoFocus={event => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        ref={contentRef}
        tabIndex={-1}
      >
        <DialogClose
          aria-label={t('common.actions.close')}
          className="absolute top-3 right-3 rounded-md p-2 text-muted-foreground opacity-80 transition-opacity hover:bg-accent hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <X aria-hidden="true" className="size-4" />
        </DialogClose>
        <DialogHeader className="items-center text-center sm:text-center">
          <DialogTitle className="text-xl leading-tight tracking-tight">
            {/* Decorative, and deliberately not part of the translated string: it would otherwise
                land in the dialog's accessible name, which is what tests and screen readers read. */}
            <span aria-hidden="true">🎬 </span>
            {t('onboarding.welcomeVideo.title')}
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm leading-relaxed">
            {t('onboarding.welcomeVideo.body')}
          </DialogDescription>
        </DialogHeader>
        {/* A fixed 16:9 box, so the dialog does not resize as the player loads. `min-h-0` lets it
            shrink inside the flex column rather than pushing the download row off a short screen. */}
        <div className="aspect-video min-h-0 w-full shrink overflow-hidden rounded-xl bg-muted">
          <iframe
            ref={frameRef}
            src={VIDEO_EMBED_URL}
            title={t('onboarding.welcomeVideo.title')}
            className="size-full border-0"
            // Delegated explicitly: a cross-origin frame gets none of these from the page it is
            // embedded in unless the frame element hands them over.
            allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
        {/* No dismiss or continue button: the dialog's own close control is the single way out,
            and a second one only crowds the row. */}
        <div className="flex w-full flex-col gap-2">
          <p className="text-center text-xs font-medium text-muted-foreground">
            {t(downloadHeading)}
          </p>
          <OnboardingDownloadButtons size="compact" accent />
        </div>
      </DialogContent>
    </Dialog>
  );
}
