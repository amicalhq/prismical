'use client';

import * as React from 'react';
import { useNavigation, useSearchParams } from '@prismical/app-client';
import {
  AlertCircle,
  CalendarDays,
  Check,
  ChevronDown,
  Loader2,
  MonitorSmartphone,
  Plus,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Card, CardContent } from '../../ui/card';
import { Checkbox } from '../../ui/checkbox';
import { Label } from '../../ui/label';
import { ListRowsSkeleton } from '../../components/skeletons';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../ui/alert-dialog';
import {
  useCalendars,
  useConnections,
  useDisconnectCalendar,
  useDisconnectEventKitIntegration,
  useDesktopCapabilities,
  useEnableEventKitIntegration,
  useEventKitIntegration,
  useFeatureFlag,
  useInvalidateConnections,
  useRefreshCalendarsOnFirstSync,
  useSetCalendarEnabled,
  type CoreCalendar,
} from '@prismical/app-client';
import type { CalendarConnection } from '@prismical/app-contracts';
import { AppleLogo, GoogleCalendarLogo } from '../../components/provider-logos';
import { useConnectFlow } from '../../lib/use-connect-flow';
import { useTranslation } from 'react-i18next';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// The server keeps connections fresh on its own (≤10 min staleness),
// so a recently-synced connection is simply "Up to date" — no timestamp arithmetic for the user.
// Past this threshold the background sync is stalled (drain failing / token trouble brewing), and
// the honest relative time returns as the signal.
const UP_TO_DATE_MS = 30 * 60_000;

function relativeTimeLabel(iso: string, locale: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return relative.format(0, 'second');
  if (minutes < 60) return relative.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return relative.format(-hours, 'hour');
  return relative.format(-Math.floor(hours / 24), 'day');
}

function providerLabel(provider: string): string {
  if (provider === 'google') return 'Google Calendar';
  if (provider === 'eventkit') return 'Apple Calendar';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

interface CalendarConnectActionsProps {
  showApple: boolean;
  appleEnabled: boolean;
  applePending: boolean;
  googlePending: boolean;
  onAppleClick: () => void;
  onGoogleClick: () => void;
}

function CalendarConnectActions({
  showApple,
  appleEnabled,
  applePending,
  googlePending,
  onAppleClick,
  onGoogleClick,
}: CalendarConnectActionsProps) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
      {showApple && (
        <Button
          type="button"
          variant="outline"
          disabled={applePending || appleEnabled}
          onClick={onAppleClick}
          aria-label={
            appleEnabled
              ? t('settings.calendar.actions.appleConnected')
              : t('settings.calendar.actions.connectApple')
          }
          className="h-auto w-full justify-between gap-2 px-3 py-2"
        >
          <span className="flex min-w-0 items-center gap-2">
            <AppleLogo className="size-4 shrink-0 object-contain" />
            <span className="truncate text-sm">Apple Calendar</span>
          </span>
          {applePending ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : appleEnabled ? (
            <Check className="size-3.5 shrink-0 text-success" aria-hidden="true" />
          ) : (
            <Plus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={googlePending}
        onClick={onGoogleClick}
        aria-label={
          googlePending
            ? t('settings.calendar.actions.connectingGoogle')
            : t('settings.calendar.actions.connectGoogle')
        }
        className="h-auto w-full justify-between gap-2 px-3 py-2"
      >
        <span className="flex min-w-0 items-center gap-2">
          <GoogleCalendarLogo className="size-4 shrink-0 object-contain" />
          <span className="truncate text-sm">Google Calendar</span>
        </span>
        {googlePending ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Plus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
      </Button>
    </div>
  );
}

// ─── Connection row ───────────────────────────────────────────────────────────

function ConnectionRow({ connection }: { connection: CalendarConnection }) {
  const { t, i18n } = useTranslation();
  const disconnect = useDisconnectCalendar();
  const connect = useConnectFlow();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  // The server flips status='error' on a revoked token (the drain or any sync path hits it);
  // the connections poll delivers it here — no client-side sync error to inspect anymore.
  const needsReconnect = connection.status === 'error';
  // Account not discovered yet: the OAuth callback's reconcile is still settling which lineage
  // this row IS (on a reconnect it merges into the existing connection and this row disappears).
  // Render it as an in-flight placeholder — with no disconnect action — so a reconnect never
  // reads as a duplicate account for the few seconds both rows exist. useConnections fast-polls
  // while it holds (lastSyncedAt is still null), so it resolves on its own.
  const isConnecting =
    !needsReconnect && connection.status === 'active' && !connection.accountEmail;
  // First sync after connect: active but never synced yet. `lastSyncedAt` populates when it
  // finishes (useConnections polls while this holds), flipping the row to a green "Connected".
  const isSyncing =
    !needsReconnect && !isConnecting && connection.status === 'active' && !connection.lastSyncedAt;

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <CalendarDays className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium leading-tight">{providerLabel(connection.provider)}</p>
          {needsReconnect ? (
            <Badge variant="destructive">{t('settings.calendar.status.reconnectNeeded')}</Badge>
          ) : isConnecting ? (
            <Badge variant="secondary" className="text-muted-foreground">
              <Loader2 className="animate-spin" />
              {t('settings.calendar.status.connecting')}
            </Badge>
          ) : isSyncing ? (
            <Badge variant="secondary" className="text-muted-foreground">
              <Loader2 className="animate-spin" />
              {t('settings.calendar.status.syncing')}
            </Badge>
          ) : (
            <Badge variant="outline" className="border-success/30 bg-success/10 text-success">
              {t('settings.calendar.status.connected')}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {isConnecting ? (
            t('settings.calendar.status.finishing')
          ) : (
            <>
              {connection.accountEmail ?? '—'}
              <span className="mx-1.5">·</span>
              {isSyncing
                ? t('settings.calendar.status.syncingCalendars')
                : !connection.lastSyncedAt
                  ? t('settings.calendar.status.neverSynced')
                  : Date.now() - new Date(connection.lastSyncedAt).getTime() < UP_TO_DATE_MS
                    ? t('settings.calendar.status.upToDate')
                    : t('settings.calendar.status.synced', {
                        time: relativeTimeLabel(
                          connection.lastSyncedAt,
                          i18n.resolvedLanguage ?? 'en'
                        ),
                      })}
            </>
          )}
        </p>
        {needsReconnect && (
          <p className="mt-0.5 text-xs text-destructive">{t('settings.calendar.status.revoked')}</p>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {needsReconnect ? (
          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={connect.pending}
            onClick={() => connect.start(connection.provider)}
          >
            {connect.pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {connect.pending
              ? t('settings.calendar.actions.reconnecting')
              : t('settings.calendar.actions.reconnect')}
          </Button>
        ) : null}
        {/* Kept visible even while connecting: if the reconcile never settles (provider outage),
            this button is the ONLY way to remove the stuck row — the server accepts a disconnect
            of a staging connection just fine. */}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
          disabled={disconnect.isPending}
          onClick={() => setConfirmOpen(true)}
          aria-label={t('settings.calendar.actions.disconnect')}
        >
          {disconnect.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.calendar.disconnect.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.calendar.disconnect.description', {
                account:
                  connection.accountEmail ?? t('settings.calendar.disconnect.accountFallback'),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => disconnect.mutate(connection.id)}>
              {t('settings.calendar.actions.disconnect')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Per-connection calendar picker ─────────────────────────────────────────────

/**
 * Sort primary first, then by name — a stable, familiar order for the checkbox list. The final
 * `id` tiebreaker is what keeps it stable: `/me/calendars` comes back ordered by `updatedAt`
 * (deltaList), and toggling a calendar bumps its `updatedAt`, so without an immutable tiebreaker
 * two same-named calendars would swap places the moment you check/uncheck one of them.
 */
function sortCalendars(cals: CoreCalendar[], locale: string): CoreCalendar[] {
  return [...cals].sort((a, b) => {
    if (Boolean(a.primary) !== Boolean(b.primary)) return a.primary ? -1 : 1;
    const byName = (a.name ?? '').localeCompare(b.name ?? '', locale);
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });
}

/**
 * A connection's calendars behind a disclosure row. The connection header + actions
 * (ConnectionRow) stay always visible above this; only the calendar list — which can be long and
 * repeats per connected account — collapses. Collapsed by default; the "N of M" count keeps the
 * current selection legible without expanding. Renders nothing until the first sync discovers the
 * calendars (so a still-syncing connection shows no empty disclosure).
 */
function ConnectionCalendars({ calendars }: { calendars: CoreCalendar[] }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = React.useState(false);
  if (calendars.length === 0) return null;
  const enabledCount = calendars.reduce((n, c) => (c.enabled !== false ? n + 1 : n), 0);
  return (
    <div className="border-t border-border/50">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      >
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
        <span className="font-medium">{t('settings.calendar.calendarsEnabled')}</span>
        <span aria-hidden="true">·</span>
        <span>
          {t('settings.calendar.enabledCount', {
            enabled: enabledCount.toLocaleString(i18n.resolvedLanguage ?? 'en'),
            total: calendars.length.toLocaleString(i18n.resolvedLanguage ?? 'en'),
          })}
        </span>
      </button>
      {open && <CalendarList calendars={calendars} />}
    </div>
  );
}

/**
 * Checkbox list of a connection's calendars — tick the ones to sync. Calendars the user
 * hid in Google arrive unticked (server default `enabled = !hidden`); toggling calls the optimistic
 * mutation, which disables → tombstones events, enables → re-syncs.
 */
function CalendarList({
  calendars,
  onChanged,
}: {
  calendars: CoreCalendar[];
  onChanged?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const setEnabled = useSetCalendarEnabled();
  return (
    <ul className="space-y-2 px-4 pb-3 pt-0.5">
      {sortCalendars(calendars, i18n.resolvedLanguage ?? 'en').map(cal => (
        <li key={cal.id} className="flex items-center gap-2.5">
          <Checkbox
            id={`cal-${cal.id}`}
            checked={cal.enabled !== false}
            onCheckedChange={v =>
              setEnabled.mutate({ id: cal.id, enabled: v === true }, { onSuccess: onChanged })
            }
          />
          {cal.color ? (
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: cal.color }}
              aria-hidden="true"
            />
          ) : null}
          <Label
            htmlFor={`cal-${cal.id}`}
            className="min-w-0 flex-1 cursor-pointer truncate text-sm font-normal"
          >
            {cal.name}
          </Label>
          {cal.primary && (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              {t('settings.calendar.primary')}
            </Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

function AppleDeviceRow({
  connection,
  calendars,
  onCalendarChanged,
}: {
  connection: CalendarConnection;
  calendars: CoreCalendar[];
  onCalendarChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div className="border-t border-border/50 first:border-t-0">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <MonitorSmartphone className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {connection.deviceName ?? t('settings.calendar.apple.deviceFallback')}
          </p>
          <p className="text-xs text-muted-foreground">
            {connection.lastSyncedAt
              ? t('settings.calendar.device.refreshed', {
                  time: relativeTimeLabel(connection.lastSyncedAt, i18n.resolvedLanguage ?? 'en'),
                })
              : t('settings.calendar.device.waiting')}
          </p>
        </div>
      </div>
      <ConnectionCalendarsWithRefresh calendars={calendars} onChanged={onCalendarChanged} />
    </div>
  );
}

function ConnectionCalendarsWithRefresh({
  calendars,
  onChanged,
}: {
  calendars: CoreCalendar[];
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = React.useState(false);
  if (calendars.length === 0) return null;
  const enabledCount = calendars.reduce((n, c) => (c.enabled !== false ? n + 1 : n), 0);
  return (
    <div className="border-t border-border/50">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      >
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
        <span className="font-medium">{t('settings.calendar.calendarsEnabled')}</span>
        <span aria-hidden="true">·</span>
        <span>
          {t('settings.calendar.enabledCount', {
            enabled: enabledCount.toLocaleString(i18n.resolvedLanguage ?? 'en'),
            total: calendars.length.toLocaleString(i18n.resolvedLanguage ?? 'en'),
          })}
        </span>
      </button>
      {open && <CalendarList calendars={calendars} onChanged={onChanged} />}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function CalendarScreen() {
  const { t, i18n } = useTranslation();
  const router = useNavigation();
  const searchParams = useSearchParams();
  // Steady-state poll: a parked settings tab keeps "Up to date" truthful and surfaces a
  // server-detected token revocation ("Reconnect needed") without needing a remount.
  const { data: connections, isLoading, error } = useConnections({ refetchInterval: 60_000 });
  const connect = useConnectFlow();
  const invalidateConnections = useInvalidateConnections();
  const { data: calendars } = useCalendars();
  const eventkitFeature = useFeatureFlag('eventkitCalendar');
  const eventkitIntegration = useEventKitIntegration({ enabled: eventkitFeature.enabled });
  const enableEventKitIntegration = useEnableEventKitIntegration();
  const disconnectEventKitIntegration = useDisconnectEventKitIntegration();
  const desktopCapabilities = useDesktopCapabilities();
  const hasNativeAppleCalendar =
    eventkitFeature.enabled && desktopCapabilities.has('apple-calendar');
  const [appleStatus, setAppleStatus] = React.useState<Awaited<
    ReturnType<typeof desktopCapabilities.getAppleCalendarStatus>
  > | null>(null);
  const [applePending, setApplePending] = React.useState(false);
  const [disconnectAppleOpen, setDisconnectAppleOpen] = React.useState(false);
  // Once the first sync finishes, pull the freshly-discovered calendars so the picker appears
  // without a manual refresh (the connections poll flips the badge but doesn't refetch calendars).
  useRefreshCalendarsOnFirstSync();
  const calByConnection = React.useMemo(() => {
    const m = new Map<string, CoreCalendar[]>();
    for (const c of calendars ?? []) {
      const arr = m.get(c.connectionId);
      if (arr) arr.push(c);
      else m.set(c.connectionId, [c]);
    }
    return m;
  }, [calendars]);
  const googleConnections = React.useMemo(
    () => (connections ?? []).filter(connection => connection.provider !== 'eventkit'),
    [connections]
  );
  const appleConnections = React.useMemo(
    () =>
      eventkitFeature.enabled
        ? (connections ?? []).filter(connection => connection.provider === 'eventkit')
        : [],
    [connections, eventkitFeature.enabled]
  );
  const appleEnabled = eventkitIntegration.data?.enabled === true;
  const appleDeviceCount = eventkitIntegration.data?.deviceCount ?? appleConnections.length;
  const hasConnections = googleConnections.length > 0 || appleEnabled;
  const settingsLoading = isLoading || (eventkitFeature.enabled && eventkitIntegration.isLoading);
  const settingsError = error ?? eventkitIntegration.error;

  React.useEffect(() => {
    if (!hasNativeAppleCalendar) return;
    void desktopCapabilities.getAppleCalendarStatus().then(setAppleStatus);
  }, [desktopCapabilities, hasNativeAppleCalendar]);

  const refreshAppleCalendar = React.useCallback(async () => {
    if (!hasNativeAppleCalendar) return;
    setApplePending(true);
    try {
      const status = await desktopCapabilities.refreshAppleCalendar();
      setAppleStatus(status);
      invalidateConnections();
      if (status.state === 'error') toast.error(t('settings.calendar.toasts.appleRefreshFailed'));
    } finally {
      setApplePending(false);
    }
  }, [desktopCapabilities, hasNativeAppleCalendar, invalidateConnections, t]);

  const enableAppleCalendar = React.useCallback(async () => {
    if (!eventkitFeature.enabled) return;
    setApplePending(true);
    try {
      if (hasNativeAppleCalendar) {
        const status = await desktopCapabilities.enableAppleCalendar();
        setAppleStatus(status);
        await eventkitIntegration.refetch();
        invalidateConnections();
        if (status.permission === 'granted') {
          toast.success(t('settings.calendar.toasts.appleConnected'));
        } else if (status.permission === 'denied' || status.permission === 'restricted') {
          toast.error(t('settings.calendar.toasts.accessBlocked'));
        } else if (status.state === 'error') {
          toast.error(t('settings.calendar.toasts.appleConnectFailed'));
        }
      } else {
        await enableEventKitIntegration.mutateAsync();
        toast.success(t('settings.calendar.toasts.appleConnectedRemote'));
      }
    } finally {
      setApplePending(false);
    }
  }, [
    desktopCapabilities,
    enableEventKitIntegration,
    eventkitFeature.enabled,
    eventkitIntegration,
    hasNativeAppleCalendar,
    invalidateConnections,
    t,
  ]);

  const disconnectAppleCalendar = React.useCallback(async () => {
    setApplePending(true);
    try {
      await disconnectEventKitIntegration.mutateAsync();
      if (hasNativeAppleCalendar) {
        const status = await desktopCapabilities.refreshAppleCalendar();
        setAppleStatus(status);
      }
      invalidateConnections();
      toast.success(t('settings.calendar.toasts.appleDisconnected'));
    } finally {
      setApplePending(false);
      setDisconnectAppleOpen(false);
    }
  }, [
    desktopCapabilities,
    disconnectEventKitIntegration,
    hasNativeAppleCalendar,
    invalidateConnections,
    t,
  ]);

  // The OAuth callback redirects back here with ?connected=1 or ?error=…
  // Capture once, then strip the params so a refresh doesn't replay it. Success is a toast
  // (auto-dismissing — the persistent green banner just sat there); failures stay as a banner
  // since an error should hold attention until acted on.
  const [errorBanner, setErrorBanner] = React.useState<string | null>(null);
  // Toasting is a side effect (unlike the old idempotent setState), so guard against React
  // StrictMode's dev double-invoke — without this the success toast stacks twice in dev.
  const handledCallback = React.useRef(false);
  React.useEffect(() => {
    const connected = searchParams.get('connected');
    const errorCode = searchParams.get('error');
    if (!connected && !errorCode) return;
    if (handledCallback.current) return;
    handledCallback.current = true;
    if (errorCode) setErrorBanner(errorCode);
    else toast.success(t('settings.calendar.toasts.connected'));
    // Desktop re-enters here via the prismical:// deep link WITHOUT a page reload, so the
    // connections query still holds its pre-connect result — pull the new connection in. (No-op
    // on web, where the round-trip already reloaded the page fresh.)
    if (connected) invalidateConnections();
    router.replace('/settings/calendar');
  }, [searchParams, router, invalidateConnections, t]);

  return (
    <div className="mx-auto w-full max-w-4xl">
      <div className="mb-8">
        <h1 className="text-xl font-bold">{t('settings.calendar.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('settings.calendar.description')}</p>
      </div>

      {errorBanner && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {t('settings.calendar.connectionFailed', { code: errorBanner })}
        </div>
      )}

      {settingsLoading ? (
        <div className="bg-muted rounded-xl overflow-hidden">
          <ListRowsSkeleton rows={1} />
        </div>
      ) : settingsError ? (
        <Card>
          <CardContent className="flex items-center gap-2 py-6 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t('settings.calendar.loadError')}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          <section aria-labelledby="connect-calendars-title">
            <h2
              id="connect-calendars-title"
              className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {t('settings.calendar.sections.connect')}
            </h2>
            <CalendarConnectActions
              showApple={eventkitFeature.enabled}
              appleEnabled={appleEnabled}
              applePending={
                applePending ||
                enableEventKitIntegration.isPending ||
                disconnectEventKitIntegration.isPending
              }
              googlePending={connect.pending}
              onAppleClick={() => void enableAppleCalendar()}
              onGoogleClick={() => connect.start('google')}
            />
          </section>

          <section aria-labelledby="connected-calendars-title">
            <h2
              id="connected-calendars-title"
              className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {t('settings.calendar.sections.connected')}
            </h2>
            <div className="space-y-3">
              {eventkitFeature.enabled && appleEnabled && (
                <div className="overflow-hidden rounded-xl bg-muted">
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <CalendarDays
                      className="h-5 w-5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">Apple Calendar</p>
                        <Badge
                          variant="outline"
                          className="border-success/30 bg-success/10 text-success"
                        >
                          {t('settings.calendar.status.connected')}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {appleDeviceCount > 0
                          ? t('settings.calendar.apple.syncingDevices', {
                              count: appleDeviceCount,
                              countLabel: appleDeviceCount.toLocaleString(
                                i18n.resolvedLanguage ?? 'en'
                              ),
                            })
                          : t('settings.calendar.apple.waitingAccess')}
                      </p>
                      {appleStatus?.state === 'error' && appleStatus.error && (
                        <p className="mt-0.5 text-xs text-destructive">
                          {t('settings.calendar.toasts.appleRefreshFailed')}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {hasNativeAppleCalendar &&
                        appleStatus !== null &&
                        appleStatus.permission !== 'granted' && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={applePending}
                            onClick={() => void enableAppleCalendar()}
                          >
                            {applePending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                            {t('settings.calendar.actions.allowMac')}
                          </Button>
                        )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                        disabled={applePending}
                        onClick={() => setDisconnectAppleOpen(true)}
                        aria-label={t('settings.calendar.actions.disconnectApple')}
                      >
                        {disconnectEventKitIntegration.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  </div>
                  {appleConnections.map(connection => (
                    <AppleDeviceRow
                      key={connection.id}
                      connection={connection}
                      calendars={calByConnection.get(connection.id) ?? []}
                      onCalendarChanged={() => void refreshAppleCalendar()}
                    />
                  ))}
                </div>
              )}
              {googleConnections.map(connection => (
                <div key={connection.id} className="bg-muted rounded-xl overflow-hidden">
                  <ConnectionRow connection={connection} />
                  <ConnectionCalendars calendars={calByConnection.get(connection.id) ?? []} />
                </div>
              ))}
              {!hasConnections && (
                <div className="space-y-2 rounded-lg border border-dashed p-6 text-center">
                  <CalendarDays
                    className="mx-auto h-8 w-8 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <p className="text-sm text-muted-foreground">
                    {t('settings.calendar.emptyTitle')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('settings.calendar.emptyDescription')}
                  </p>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      <AlertDialog open={disconnectAppleOpen} onOpenChange={setDisconnectAppleOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.calendar.apple.disconnectTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.calendar.apple.disconnectDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={disconnectEventKitIntegration.isPending}
              onClick={() => void disconnectAppleCalendar()}
            >
              {disconnectEventKitIntegration.isPending
                ? t('settings.calendar.actions.disconnecting')
                : t('settings.calendar.actions.disconnect')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
