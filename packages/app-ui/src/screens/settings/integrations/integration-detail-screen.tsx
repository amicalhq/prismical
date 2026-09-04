'use client';

import * as React from 'react';
import { useApplicationLocale } from '@prismical/app-i18n';
import { useTranslation } from 'react-i18next';
import { AppLink as Link } from '../../../shell/app-link';
import { useNavigation, useSearchParams, usePorts } from '@prismical/app-client';
import { toast } from 'sonner';
import { ArrowLeft, KeyRound, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../ui/alert-dialog';
import { Badge } from '../../../ui/badge';
import { Button } from '../../../ui/button';
import { Switch } from '../../../ui/switch';
import { ListRowsSkeleton } from '../../../components/skeletons';
import { DataError } from '../../../components/data-error';
import { IntegrationLogo } from '../../../components/integration-brand-mark';
import {
  useAuthorizeMcpServer,
  useDeleteMcpServer,
  useMcpServer,
  useTestMcpServer,
  useUpdateMcpServer,
  type McpTool,
} from '@prismical/app-client';
import { McpStatusBadge } from './components/shared';
import { FeatureGate } from '../../../shell/feature-gate';

// Settings › Integrations › server detail: personal connection health and
// per-tool enable switches with the "all tools (incl. future)" master switch represented by `null`.

function ToolKindBadge({ tool }: { tool: McpTool }) {
  const { t } = useTranslation();
  const a = tool.annotations;
  if (a?.destructiveHint)
    return <Badge variant="destructive">{t('settings.integrations.toolKinds.destructive')}</Badge>;
  if (a?.readOnlyHint === true)
    return (
      <Badge variant="ghost" className="text-muted-foreground">
        {t('settings.integrations.toolKinds.read')}
      </Badge>
    );
  if (a?.readOnlyHint === false)
    return (
      <Badge variant="outline" className="border-warning/30 bg-warning/10 text-warning">
        {t('settings.integrations.toolKinds.write')}
      </Badge>
    );
  return null;
}

export function IntegrationDetailScreen({ id }: { id: string }) {
  return (
    <FeatureGate feature="integrations" fallbackHref="/settings/integrations">
      <IntegrationDetailContent id={id} />
    </FeatureGate>
  );
}

function IntegrationDetailContent({ id }: { id: string }) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const router = useNavigation();
  const searchParams = useSearchParams();
  const { external } = usePorts();
  const query = useMcpServer(id);
  const { data: server, isLoading, error } = query;
  const update = useUpdateMcpServer();
  const test = useTestMcpServer();
  const del = useDeleteMcpServer();
  const authorize = useAuthorizeMcpServer();
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [banner, setBanner] = React.useState<'connected' | 'error' | null>(null);

  // OAuth return (calendar pattern): the callback bounces here with ?connected=1 / ?error=…;
  // show a one-time banner and strip the params so refresh doesn't replay it.
  React.useEffect(() => {
    const connected = searchParams.get('connected');
    const err = searchParams.get('error');
    if (!connected && !err) return;
    setBanner(connected ? 'connected' : 'error');
    router.replace(`/settings/integrations/${id}`);
  }, [searchParams, router, id]);

  const startOAuth = () => {
    authorize.mutate(
      {
        id,
        returnTo: external.authorizationReturnTo(`/settings/integrations/${id}`),
      },
      {
        onSuccess: r => {
          if (r.url) external.openAuthorizationUrl(r.url);
          else toast.success(t('settings.integrations.detail.alreadyConnected'));
        },
        onError: () => toast.error(t('settings.integrations.detail.connectStartError')),
      }
    );
  };

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-4xl">
        <ListRowsSkeleton rows={4} />
      </div>
    );
  }
  if (error || !server) {
    return (
      <div className="mx-auto w-full max-w-4xl">
        <DataError onRetry={() => void query.refetch()} />
      </div>
    );
  }

  const allToolsOn = server.enabledTools === null;
  const enabledSet = new Set(server.enabledTools ?? []);
  const isToolOn = (name: string) => allToolsOn || enabledSet.has(name);

  const setAllTools = (on: boolean) => {
    // Master ON = `null` (everything, including tools added by later refreshes).
    // Master OFF = snapshot the current set so the user can prune from "all on".
    update.mutate({ id, enabledTools: on ? null : server.tools.map(t => t.name) });
  };

  const toggleTool = (name: string, on: boolean) => {
    const base = allToolsOn ? server.tools.map(t => t.name) : (server.enabledTools ?? []);
    const next = on ? [...new Set([...base, name])] : base.filter(n => n !== name);
    update.mutate({ id, enabledTools: next });
  };

  const runTest = () => {
    test.mutate(id, {
      // The response is a discriminated union, so `toolCount` has to be narrowed to read it.
      // The `success: false` arm is NOT the live failure path and is unreachable from here today:
      // core only ever sends it with HTTP 502 (mcp-servers.ts), and the client throws ApiError on
      // any non-2xx, so a failed probe lands in `onError` below. This branch exists to keep the
      // union exhaustive — if core ever starts returning that arm with a 2xx, it surfaces the
      // reason instead of silently rendering "found undefined tools".
      onSuccess: r =>
        r.success
          ? toast.success(
              t('settings.integrations.detail.foundTools', {
                countLabel: r.toolCount.toLocaleString(resolvedLocale),
              })
            )
          : toast.error(
              t('settings.integrations.detail.connectionFailedReason', {
                reason: r.statusReason,
              })
            ),
      onError: () => toast.error(t('settings.integrations.detail.connectionFailed')),
    });
  };

  const metaBits = [
    server.url,
    server.authType === 'none'
      ? t('settings.integrations.auth.noAuthentication')
      : server.authType.toUpperCase(),
    server.meta?.serverInfo
      ? `${server.meta.serverInfo.name} v${server.meta.serverInfo.version}`
      : null,
  ].filter(Boolean);

  return (
    <div className="mx-auto w-full max-w-4xl">
      <Link
        href="/settings/integrations"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> {t('settings.integrations.screen.title')}
      </Link>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <IntegrationLogo directoryKey={server.directoryKey} name={server.name} size="sm" />
            <h1 className="truncate text-xl font-bold">{server.name}</h1>
            <McpStatusBadge status={server.status} />
            <Badge variant="outline" className="bg-background text-muted-foreground">
              {t('settings.integrations.badges.personal')}
            </Badge>
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">{metaBits.join(' · ')}</p>
          {(server.status === 'error' || server.status === 'needs_auth') && server.statusReason && (
            <p className="mt-1 text-sm text-destructive">{server.statusReason}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {server.authType === 'oauth' && server.status !== 'active' && (
            <Button size="sm" onClick={startOAuth} disabled={authorize.isPending}>
              {authorize.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <KeyRound className="h-3.5 w-3.5" />
              )}
              {server.status === 'needs_auth'
                ? t('settings.integrations.actions.reconnect')
                : t('settings.integrations.actions.connect')}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={runTest} disabled={test.isPending}>
            {test.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t('settings.integrations.actions.refreshTools')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('settings.integrations.actions.remove')}
          </Button>
        </div>
      </div>

      {banner === 'connected' && (
        <div className="mb-4 rounded-lg bg-success/10 px-4 py-2.5 text-sm text-success">
          {t('settings.integrations.detail.connectedLoading')}
        </div>
      )}
      {banner === 'error' && (
        <div className="mb-4 rounded-lg bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          {t('settings.integrations.detail.signInFailed')}
        </div>
      )}

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('settings.integrations.detail.tools', {
              count: server.tools.length,
              countLabel: server.tools.length.toLocaleString(resolvedLocale),
            })}
          </h2>
          {server.tools.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={allToolsOn}
                onCheckedChange={setAllTools}
                disabled={update.isPending}
                aria-label={t('settings.integrations.detail.enableAllAria')}
              />
              {t('settings.integrations.detail.enableAll')}
            </label>
          )}
        </div>

        {server.tools.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t('settings.integrations.detail.noTools')}
          </div>
        ) : (
          <div className="divide-y divide-border/50 overflow-hidden rounded-xl bg-muted">
            {server.tools.map(tool => (
              <div key={tool.name} className="flex items-center gap-3 px-4 py-3">
                <Switch
                  checked={isToolOn(tool.name)}
                  // Deliberately usable from the all-on state ("toggle off
                  // delete_block" is one click) — toggleTool snapshots the full set first.
                  onCheckedChange={on => toggleTool(tool.name, on)}
                  disabled={update.isPending}
                  aria-label={t('settings.integrations.detail.enableToolAria', {
                    name: tool.name,
                  })}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-xs font-medium">{tool.name}</code>
                    <ToolKindBadge tool={tool} />
                  </div>
                  {tool.description && (
                    <p className="truncate text-xs text-muted-foreground">{tool.description}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {server.tools.length > 0 && !allToolsOn && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('settings.integrations.detail.newToolsDisabled')}
          </p>
        )}
      </section>

      <AlertDialog
        open={confirmDelete}
        onOpenChange={next => !del.isPending && setConfirmDelete(next)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings.integrations.detail.removeTitle', { name: server.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.integrations.detail.removeDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={del.isPending}>
              {t('settings.integrations.actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={e => {
                e.preventDefault();
                del.mutate(server.id, {
                  onSuccess: () => {
                    toast.success(t('settings.integrations.detail.removed', { name: server.name }));
                    router.push('/settings/integrations');
                  },
                });
              }}
              disabled={del.isPending}
            >
              {del.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('settings.integrations.actions.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
