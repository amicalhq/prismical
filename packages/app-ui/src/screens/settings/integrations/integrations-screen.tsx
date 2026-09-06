'use client';

import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { useApplicationLocale, type ApplicationTFunction } from '@prismical/app-i18n';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  Bot,
  Braces,
  Cable,
  CircleAlert,
  ExternalLink,
  KeyRound,
  Loader2,
  Mail,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Webhook,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  useAuthorizeMcpServer,
  useAutomations,
  useCreateMcpServer,
  useEntitlements,
  useFeatureFlag,
  useMcpServers,
  useNavigation,
  usePorts,
  useSearchParams,
  useTestMcpServer,
  type Automation,
  type CreateMcpServerInput,
  type McpAuthType,
  type McpServer,
} from '@prismical/app-client';
import { AppLink as Link } from '../../../shell/app-link';
import { DataError } from '../../../components/data-error';
import { IntegrationLogo } from '../../../components/integration-brand-mark';
import { ListRowsSkeleton } from '../../../components/skeletons';
import { cn } from '../../../lib/utils';
import { Badge } from '../../../ui/badge';
import { Button } from '../../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../ui/dialog';
import { Input } from '../../../ui/input';
import { Label } from '../../../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select';
import { Textarea } from '../../../ui/textarea';
import {
  AutomationDialog,
  type AutomationPreset,
} from '../automations/components/automation-dialog';
import { eventTypeLabel, webhookHost } from '../automations/components/automation-format';
import {
  MCP_DIRECTORY,
  MCP_REGISTRY_URL,
  mcpDirectoryDescription,
  type McpDirectoryCategory,
  type McpDirectoryEntry,
} from '../mcp-directory';
import { McpStatusBadge, relativeTime } from './components/shared';

const AUTOMATION_CATALOG_DESCRIPTION_KEYS = {
  activepieces: 'settings.integrations.catalog.descriptions.activepieces',
  make: 'settings.integrations.catalog.descriptions.make',
  n8n: 'settings.integrations.catalog.descriptions.n8n',
  zapier: 'settings.integrations.catalog.descriptions.zapier',
} as const;

type AutomationCatalogDescriptionKey = keyof typeof AUTOMATION_CATALOG_DESCRIPTION_KEYS;

interface CatalogItem {
  key: string;
  name: string;
  category: McpDirectoryCategory;
  kind: 'mcp' | 'automation';
  descriptionKey?: AutomationCatalogDescriptionKey;
  entry?: McpDirectoryEntry;
  preset?: AutomationPreset;
}

// Providers whose connect flow is actually live. The rest of MCP_DIRECTORY used to render as
// disabled "Coming soon" cards; they are now simply absent, and the Request card below is how a
// member asks for one. Add a key here when its flow ships.
const CURATED_DIRECTORY_KEYS = ['notion'];

/** Long-tail integration requests come in by mail — there is no in-product request queue yet. */
const INTEGRATION_REQUEST_MAILTO =
  'mailto:help@prismical.ai?subject=' + encodeURIComponent('Integration request');
const CURATED_DIRECTORY = CURATED_DIRECTORY_KEYS.map(key =>
  MCP_DIRECTORY.find(entry => entry.key === key)
).filter((entry): entry is McpDirectoryEntry => Boolean(entry));

const APP_CATALOG: CatalogItem[] = [
  {
    key: 'zapier',
    name: 'Zapier',
    descriptionKey: 'zapier',
    category: 'automation',
    kind: 'automation',
    preset: 'zapier',
  },
  {
    key: 'n8n',
    name: 'n8n',
    descriptionKey: 'n8n',
    category: 'automation',
    kind: 'automation',
    preset: 'n8n',
  },
  {
    key: 'activepieces',
    name: 'Activepieces',
    descriptionKey: 'activepieces',
    category: 'automation',
    kind: 'automation',
    preset: 'activepieces',
  },
  {
    key: 'make',
    name: 'Make',
    descriptionKey: 'make',
    category: 'automation',
    kind: 'automation',
    preset: 'make',
  },
  ...CURATED_DIRECTORY.map(entry => ({
    key: entry.key,
    name: entry.name,
    category: entry.category,
    kind: 'mcp' as const,
    entry,
  })),
];

const CATEGORY_LABEL_KEYS = {
  crm: 'settings.integrations.catalog.categories.crm',
  productivity: 'settings.integrations.catalog.categories.productivity',
  support: 'settings.integrations.catalog.categories.support',
  docs: 'settings.integrations.catalog.categories.knowledge',
  chat: 'settings.integrations.catalog.categories.communication',
  storage: 'settings.integrations.catalog.categories.storage',
  dev: 'settings.integrations.catalog.categories.developer',
  automation: 'settings.integrations.catalog.categories.automation',
} as const satisfies Record<McpDirectoryCategory, string>;

const CATALOG_CATEGORIES = ['all', 'automation', 'crm', 'docs', 'chat', 'dev'] as const;

function categoryLabel(category: McpDirectoryCategory, t: ApplicationTFunction): string {
  return t(CATEGORY_LABEL_KEYS[category]);
}

function catalogDescription(item: CatalogItem, t: ApplicationTFunction): string {
  if (item.entry) return mcpDirectoryDescription(item.entry, t);
  if (item.descriptionKey) return t(AUTOMATION_CATALOG_DESCRIPTION_KEYS[item.descriptionKey]);
  return '';
}

function CatalogCategoryBadge({ category }: { category: McpDirectoryCategory }) {
  const { t } = useTranslation();
  return (
    <Badge variant="outline" className="bg-background/70 text-muted-foreground">
      {categoryLabel(category, t)}
    </Badge>
  );
}

function serverDetail(server: McpServer, t: ApplicationTFunction, locale: string): string {
  if (server.status === 'error' || server.status === 'needs_auth') {
    return server.statusReason ?? t('settings.integrations.detail.connectionNeedsAttention');
  }
  const meta = [
    server.authType === 'none'
      ? t('settings.integrations.auth.noAuthentication')
      : server.authType.toUpperCase(),
    t('settings.integrations.detail.toolCount', {
      count: server.toolCount,
      countLabel: server.toolCount.toLocaleString(locale),
    }),
  ];
  const refreshed = relativeTime(server.toolsCachedAt, locale);
  if (refreshed) meta.push(t('settings.integrations.detail.refreshed', { time: refreshed }));
  return meta.join(' · ');
}

function isEstablishedMcpServer(server: McpServer): boolean {
  return (
    server.lastConnectedAt != null || server.status === 'active' || server.status === 'disabled'
  );
}

function ServerConnectionRow({ server }: { server: McpServer }) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  return (
    <li className="group flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 transition-colors hover:bg-accent">
      <IntegrationLogo directoryKey={server.directoryKey} name={server.name} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="truncate text-sm font-semibold">{server.name}</h3>
          <Badge variant="ghost" className="text-muted-foreground">
            {t('settings.integrations.badges.mcp')}
          </Badge>
          <Badge variant="outline" className="bg-background/70 text-muted-foreground">
            {t('settings.integrations.badges.personal')}
          </Badge>
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
          {serverDetail(server, t, resolvedLocale)}
        </p>
      </div>
      <div className="ml-[3.25rem] flex w-[calc(100%_-_3.25rem)] shrink-0 items-center justify-between sm:ml-0 sm:w-auto sm:gap-3">
        <McpStatusBadge status={server.status} />
        <Button asChild size="sm" variant="ghost" className="h-7 px-2.5 text-xs">
          <Link href={`/settings/integrations/${server.id}`}>
            {t('settings.integrations.actions.manage')}
          </Link>
        </Button>
      </div>
    </li>
  );
}

function automationProviderKey(automation: Automation): string | null {
  const target = `${automation.name} ${automation.actionConfig.url}`.toLowerCase();
  if (target.includes('hooks.zapier.com') || target.includes('zapier')) return 'zapier';
  if (target.includes('activepieces')) return 'activepieces';
  if (target.includes('make.com') || target.includes('→ make')) return 'make';
  if (target.includes('n8n')) return 'n8n';
  return null;
}

function automationStatus(
  automation: Automation,
  t: ApplicationTFunction
): { label: string; className: string } {
  if (!automation.enabled) {
    return {
      label: t('settings.integrations.status.paused'),
      className: 'text-muted-foreground',
    };
  }
  if (automation.lastRun?.status === 'failed') {
    return {
      label: t('settings.integrations.status.needsAttention'),
      className: 'text-destructive',
    };
  }
  if (automation.lastRun?.status === 'pending' || automation.lastRun?.status === 'running') {
    return {
      label: t('settings.integrations.status.delivering'),
      className: 'text-warning',
    };
  }
  return { label: t('settings.integrations.status.active'), className: 'text-success' };
}

function AutomationConnectionRow({ automation }: { automation: Automation }) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const providerKey = automationProviderKey(automation);
  const status = automationStatus(automation, t);
  const events = new Intl.ListFormat(resolvedLocale, {
    type: 'disjunction',
  }).format(automation.triggerConfig.eventTypes.map(type => eventTypeLabel(type, t)));

  return (
    <li className="group flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 transition-colors hover:bg-accent">
      {providerKey ? (
        <IntegrationLogo directoryKey={providerKey} name={automation.name} />
      ) : (
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-blue-500/10 text-blue-700 dark:text-blue-300">
          <Webhook className="size-4.5" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="truncate text-sm font-semibold">{automation.name}</h3>
          <Badge variant="outline" className="bg-background/70 text-muted-foreground">
            {t('settings.integrations.badges.automation')}
          </Badge>
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
          {events} → {webhookHost(automation)}
        </p>
      </div>
      <div className="ml-[3.25rem] flex w-[calc(100%_-_3.25rem)] shrink-0 items-center justify-between sm:ml-0 sm:w-auto sm:gap-3">
        <span
          className={cn('inline-flex items-center gap-1.5 text-xs font-medium', status.className)}
        >
          <span className="size-1.5 rounded-full bg-current" />
          {status.label}
        </span>
        <Button asChild size="sm" variant="ghost" className="h-7 px-2.5 text-xs">
          <Link href={`/settings/integrations/automations/${automation.id}`}>
            {t('settings.integrations.actions.manage')}
          </Link>
        </Button>
      </div>
    </li>
  );
}

interface AddDialogState {
  open: boolean;
  /** Prefill from a curated entry; undefined = blank custom form. */
  entry?: McpDirectoryEntry;
}

function AddIntegrationDialog({
  state,
  onOpenChange,
}: {
  state: AddDialogState;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const router = useNavigation();
  const { external } = usePorts();
  const create = useCreateMcpServer();
  const test = useTestMcpServer();
  const authorize = useAuthorizeMcpServer();
  const entry = state.entry;

  const [name, setName] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [authType, setAuthType] = React.useState<McpAuthType>('none');
  const [token, setToken] = React.useState('');
  const [headersJson, setHeadersJson] = React.useState('');
  const [formError, setFormError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!state.open) return;
    setName(entry?.name ?? '');
    setUrl(entry?.url ?? '');
    setAuthType(entry?.authType ?? 'none');
    setToken('');
    setHeadersJson('');
    setFormError(null);
  }, [state.open, entry]);

  const busy = create.isPending || test.isPending || authorize.isPending;

  const submit = async () => {
    setFormError(null);
    const input: CreateMcpServerInput = {
      name: name.trim(),
      url: url.trim(),
      authType,
      ...(entry ? { directoryKey: entry.key } : {}),
    };
    if (!input.name || !input.url) {
      setFormError(t('settings.integrations.custom.required'));
      return;
    }
    if (authType === 'bearer') {
      if (!token.trim()) {
        setFormError(t('settings.integrations.custom.tokenRequired'));
        return;
      }
      input.secret = { token: token.trim() };
    } else if (authType === 'headers') {
      try {
        const parsed = JSON.parse(headersJson || '{}') as Record<string, string>;
        if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
          throw new Error('empty');
        }
        input.secret = { headers: parsed };
      } catch {
        setFormError(t('settings.integrations.custom.headersInvalid'));
        return;
      }
    }
    let createdId: string | null = null;
    try {
      const created = await create.mutateAsync(input);
      createdId = created.id;
      if (authType === 'oauth') {
        const { url } = await authorize.mutateAsync({
          id: created.id,
          returnTo: external.authorizationReturnTo(`/settings/integrations/${created.id}`),
        });
        if (url) {
          onOpenChange(false);
          external.openAuthorizationUrl(url);
          return;
        }
      } else {
        await test.mutateAsync(created.id).catch(() => {});
      }
      onOpenChange(false);
      toast.success(t('settings.integrations.custom.added', { name: created.name }));
      router.push(`/settings/integrations/${created.id}`);
    } catch {
      if (createdId) {
        onOpenChange(false);
        router.push(`/settings/integrations/${createdId}?error=setup_failed`);
        return;
      }
      setFormError(t('settings.integrations.custom.addFailed'));
    }
  };

  return (
    <Dialog open={state.open} onOpenChange={next => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {entry
              ? t('settings.integrations.custom.connectTitle', { name: entry.name })
              : t('settings.integrations.custom.addTitle')}
          </DialogTitle>
          <DialogDescription>
            {entry ? (
              <>{t('settings.integrations.custom.hostedDescription')}</>
            ) : (
              <>
                {t('settings.integrations.custom.browsePrefix')}{' '}
                <a
                  href={MCP_REGISTRY_URL}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t('settings.integrations.custom.registryAria')}
                  className="underline underline-offset-2"
                >
                  {t('settings.integrations.custom.registryName')}
                </a>{' '}
                {t('settings.integrations.custom.browseSuffix')}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="mcp-name">{t('settings.integrations.custom.nameLabel')}</Label>
            <Input
              id="mcp-name"
              name="mcp-name"
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder={t('settings.integrations.custom.namePlaceholder')}
              autoComplete="off"
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-url">{t('settings.integrations.custom.serverUrlLabel')}</Label>
            <Input
              id="mcp-url"
              name="mcp-url"
              type="url"
              value={url}
              onChange={event => setUrl(event.target.value)}
              placeholder="https://mcp.example.com/mcp…"
              autoComplete="url"
              spellCheck={false}
              disabled={busy}
              aria-describedby={
                !entry || (!entry.url && entry.docsUrl) ? 'mcp-url-help' : undefined
              }
              className="font-mono text-xs"
            />
            {entry && !entry.url && entry.docsUrl ? (
              <p id="mcp-url-help" className="text-xs text-muted-foreground">
                <a href={entry.docsUrl} target="_blank" rel="noreferrer" className="underline">
                  {t('settings.integrations.custom.endpointHelpNamed', { name: entry.name })}
                </a>
              </p>
            ) : !entry ? (
              <p id="mcp-url-help" className="text-xs text-muted-foreground">
                {t('settings.integrations.custom.endpointHelp')}
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-auth-type">{t('settings.integrations.auth.authentication')}</Label>
            <Select
              value={authType}
              onValueChange={value => setAuthType(value as McpAuthType)}
              disabled={busy}
            >
              <SelectTrigger id="mcp-auth-type" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('settings.integrations.auth.none')}</SelectItem>
                <SelectItem value="oauth">{t('settings.integrations.auth.oauth')}</SelectItem>
                <SelectItem value="bearer">{t('settings.integrations.auth.bearer')}</SelectItem>
                <SelectItem value="headers">
                  {t('settings.integrations.auth.customHeaders')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {authType === 'bearer' ? (
            <div className="space-y-1.5">
              <Label htmlFor="mcp-token">{t('settings.integrations.auth.token')}</Label>
              <Input
                id="mcp-token"
                name="mcp-token"
                type="password"
                value={token}
                onChange={event => setToken(event.target.value)}
                autoComplete="off"
                disabled={busy}
              />
            </div>
          ) : null}
          {authType === 'headers' ? (
            <div className="space-y-1.5">
              <Label htmlFor="mcp-headers">{t('settings.integrations.auth.headersJson')}</Label>
              <Textarea
                id="mcp-headers"
                name="mcp-headers"
                value={headersJson}
                onChange={event => setHeadersJson(event.target.value)}
                placeholder='{"X-Api-Key": "…"}'
                autoComplete="off"
                spellCheck={false}
                rows={3}
                disabled={busy}
              />
            </div>
          ) : null}
          {authType === 'oauth' ? (
            <p className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {t('settings.integrations.custom.oauthHelp')}
            </p>
          ) : null}
          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('settings.integrations.actions.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {busy
              ? t('settings.integrations.actions.connecting')
              : t('settings.integrations.actions.addIntegration')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProviderDialog({
  entry,
  onOpenChange,
}: {
  entry: McpDirectoryEntry | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const router = useNavigation();
  const { external } = usePorts();
  const create = useCreateMcpServer();
  const authorize = useAuthorizeMcpServer();
  const [error, setError] = React.useState<string | null>(null);
  const busy = create.isPending || authorize.isPending;

  React.useEffect(() => {
    if (entry) setError(null);
  }, [entry]);

  const connect = async () => {
    if (!entry?.url) return;
    setError(null);
    try {
      const created = await create.mutateAsync({
        name: entry.name,
        url: entry.url,
        authType: entry.authType,
        directoryKey: entry.key,
      });
      const authorization = await authorize.mutateAsync({
        id: created.id,
        returnTo: external.authorizationReturnTo('/settings/integrations'),
      });
      if (authorization.url) {
        onOpenChange(false);
        external.openAuthorizationUrl(authorization.url);
        return;
      }
      onOpenChange(false);
      router.push(`/settings/integrations/${created.id}`);
    } catch {
      setError(t('settings.integrations.provider.connectError', { name: entry.name }));
    }
  };

  return (
    <Dialog open={Boolean(entry)} onOpenChange={open => !busy && onOpenChange(open)}>
      <DialogContent className="sm:max-w-lg">
        {entry ? (
          <>
            <DialogHeader>
              <div className="mb-2 flex items-start gap-3">
                <IntegrationLogo directoryKey={entry.key} name={entry.name} />
                <div className="min-w-0 space-y-1.5">
                  <CatalogCategoryBadge category={entry.category} />
                  <DialogTitle>
                    {t('settings.integrations.actions.connectNamed', { name: entry.name })}
                  </DialogTitle>
                </div>
              </div>
              <DialogDescription>{mcpDirectoryDescription(entry, t)}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="rounded-xl border bg-muted/35 p-3 text-sm text-muted-foreground">
                {t('settings.integrations.provider.description', { name: entry.name })}
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2.5 text-sm">
                  <Bot className="size-4 text-muted-foreground" />
                  {t('settings.integrations.provider.makeToolsAvailable')}
                </div>
                <div className="flex items-center gap-2.5 text-sm">
                  <ShieldCheck className="size-4 text-muted-foreground" />
                  {t('settings.integrations.provider.reviewActions')}
                </div>
                <div className="flex items-center gap-2.5 text-sm">
                  <Settings2 className="size-4 text-muted-foreground" />
                  {t('settings.integrations.provider.manageLater')}
                </div>
              </div>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>

            <DialogFooter className="sm:justify-between">
              {entry.docsUrl ? (
                <Button asChild variant="ghost" className="px-2 text-muted-foreground">
                  <a href={entry.docsUrl} target="_blank" rel="noreferrer">
                    {t('settings.integrations.actions.setupGuide')}
                    <ExternalLink className="size-3.5" />
                  </a>
                </Button>
              ) : (
                <span />
              )}
              <Button onClick={() => void connect()} disabled={busy || !entry.url}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {busy
                  ? t('settings.integrations.actions.connecting')
                  : t('settings.integrations.actions.connectNamed', { name: entry.name })}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ConnectionMethodCard({
  icon: Icon,
  name,
  description,
  destination,
  tone,
  href,
  onClick,
}: {
  icon: LucideIcon;
  name: string;
  description: string;
  destination: string;
  tone: string;
  href?: string;
  onClick?: () => void;
}) {
  const className =
    'group flex min-h-44 flex-col bg-background p-4 text-left transition-colors hover:bg-muted/45 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none';
  const content = (
    <>
      <span className={cn('grid size-9 place-items-center rounded-xl', tone)}>
        <Icon aria-hidden="true" className="size-4.5" />
      </span>
      <span className="mt-5 text-sm font-semibold">{name}</span>
      <span className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</span>
      <span className="mt-auto flex w-full items-center justify-between pt-5 text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {destination}
        <ArrowRight
          aria-hidden="true"
          className="size-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none"
        />
      </span>
    </>
  );

  if (href) {
    return (
      <Link href={href} className={className}>
        {content}
      </Link>
    );
  }

  return (
    <button type="button" onClick={onClick} className={className}>
      {content}
    </button>
  );
}

function CatalogCard({
  item,
  server,
  onClick,
}: {
  item: CatalogItem;
  server?: McpServer;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const action = server
    ? isEstablishedMcpServer(server)
      ? t('settings.integrations.catalog.actions.manageConnection')
      : t('settings.integrations.catalog.actions.continueSetup')
    : item.kind === 'automation'
      ? t('settings.integrations.catalog.actions.createAutomation')
      : t('settings.integrations.catalog.actions.connect');

  const className = cn(
    'group flex min-h-40 w-full flex-col rounded-xl border bg-card p-4 text-left shadow-xs transition-[border-color,box-shadow,transform,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transform-none motion-reduce:transition-none',
    'hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md'
  );
  const content = (
    <>
      <span className="flex w-full items-start justify-between gap-2">
        <IntegrationLogo directoryKey={item.key} name={item.name} size="sm" />
        <CatalogCategoryBadge category={item.category} />
      </span>
      <span className="mt-4 text-sm font-semibold">{item.name}</span>
      <span className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {catalogDescription(item, t)}
      </span>
      <span className="mt-auto flex w-full items-center justify-between pt-4 text-xs font-medium text-muted-foreground">
        {action}
        <ArrowRight
          aria-hidden="true"
          className="size-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none"
        />
      </span>
    </>
  );

  if (server) {
    return (
      <Link href={`/settings/integrations/${server.id}`} className={className}>
        {content}
      </Link>
    );
  }

  return (
    <button type="button" onClick={onClick} className={className}>
      {content}
    </button>
  );
}

/**
 * Tail card of the catalog grid: the long tail is a mail request rather than a dead "coming soon"
 * tile, so a member can name the app they need and we hear about it.
 */
function RequestIntegrationCard() {
  const { t } = useTranslation();
  return (
    <a
      href={INTEGRATION_REQUEST_MAILTO}
      className="group flex min-h-40 w-full flex-col rounded-xl border border-dashed bg-card p-4 text-left shadow-xs transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transform-none motion-reduce:transition-none"
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Mail aria-hidden="true" className="size-4" />
      </span>
      <span className="mt-4 text-sm font-semibold">
        {t('settings.integrations.catalog.requestMore.name')}
      </span>
      <span className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {t('settings.integrations.catalog.requestMore.description')}
      </span>
      <span className="mt-auto flex w-full items-center justify-between pt-4 text-xs font-medium text-muted-foreground">
        {t('settings.integrations.catalog.actions.requestMore')}
        <ArrowRight
          aria-hidden="true"
          className="size-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none"
        />
      </span>
    </a>
  );
}

export function IntegrationsScreen() {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const router = useNavigation();
  const searchParams = useSearchParams();
  const { enabled: integrationsEnabled, isResolved: integrationsResolved } =
    useFeatureFlag('integrations');
  // Narrower gate: Advanced setup (connect any server by URL) is still in development, so it is
  // off for customers while the curated connections above stay available. The server enforces
  // this too — it omits custom rows from the list and 403s every custom-row operation.
  const { enabled: customMcpEnabled } = useFeatureFlag('customMcpServers');
  const { entitlements } = useEntitlements();
  const customServersEnabled = integrationsEnabled && customMcpEnabled;
  const mcpQuery = useMcpServers(integrationsResolved && integrationsEnabled);
  const refetchMcpServers = mcpQuery.refetch;
  const automationQuery = useAutomations();
  const [addDialog, setAddDialog] = React.useState<AddDialogState>({ open: false });
  const [providerEntry, setProviderEntry] = React.useState<McpDirectoryEntry>();
  const [automationPreset, setAutomationPreset] = React.useState<AutomationPreset>();
  const [search, setSearch] = React.useState('');
  const [category, setCategory] = React.useState<McpDirectoryCategory | 'all'>('all');
  const [callbackError, setCallbackError] = React.useState<
    'accessDenied' | 'exchangeFailed' | 'failed' | null
  >(null);
  const handledCallback = React.useRef<string | null>(null);

  // React Query retains cached data when a query becomes disabled. Mask it as well
  // as stopping the request so switching the flag off cannot leave stale MCP rows visible.
  const servers = (integrationsEnabled ? (mcpQuery.data ?? []) : []).filter(
    // Belt and braces with the server-side filter: never surface a connection the member cannot
    // open, rename or disconnect.
    server => customServersEnabled || Boolean(server.directoryKey)
  );
  const connectedServers = servers.filter(isEstablishedMcpServer);
  const setupServers = servers.filter(server => !isEstablishedMcpServer(server));
  const automations = automationQuery.data ?? [];
  const serverByDirectoryKey = new Map(
    servers.flatMap(server =>
      server.directoryKey ? ([[server.directoryKey, server]] as const) : []
    )
  );

  const catalog = APP_CATALOG.filter(item => {
    if (!integrationsEnabled && item.kind === 'mcp') return false;
    if (category !== 'all' && item.category !== category) return false;
    const query = search.trim().toLocaleLowerCase(resolvedLocale);
    if (!query) return true;
    return `${item.name} ${catalogDescription(item, t)}`
      .toLocaleLowerCase(resolvedLocale)
      .includes(query);
  });

  const connectedCount = (integrationsEnabled ? connectedServers.length : 0) + automations.length;
  const connectionQueriesPending =
    automationQuery.isLoading || (integrationsEnabled && mcpQuery.isLoading);
  const showEmptyConnections =
    !connectionQueriesPending &&
    (!integrationsEnabled || !mcpQuery.error) &&
    !automationQuery.error &&
    connectedCount === 0 &&
    setupServers.length === 0;

  const openAutomation = (preset: AutomationPreset) => setAutomationPreset(preset);

  React.useEffect(() => {
    const connected = searchParams.get('connected');
    const errorCode = searchParams.get('error');
    if (!connected && !errorCode) {
      handledCallback.current = null;
      return;
    }

    const callbackKey = searchParams.toString();
    if (handledCallback.current === callbackKey) return;

    if (!integrationsResolved) return;
    handledCallback.current = callbackKey;
    if (!integrationsEnabled) {
      router.replace('/settings/integrations');
      return;
    }

    if (errorCode) {
      const message: 'accessDenied' | 'exchangeFailed' | 'failed' =
        errorCode === 'access_denied' || errorCode === 'denied'
          ? 'accessDenied'
          : errorCode === 'exchange_failed'
            ? 'exchangeFailed'
            : 'failed';
      setCallbackError(message);
    } else {
      setCallbackError(null);
      toast.success(t('settings.integrations.callback.connected'));
    }
    void refetchMcpServers();
    router.replace('/settings/integrations');
  }, [integrationsEnabled, integrationsResolved, refetchMcpServers, router, searchParams, t]);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="mb-10">
        <div>
          <p className="mb-2 text-2xs font-bold uppercase tracking-[0.12em] text-muted-foreground">
            {t('settings.integrations.screen.eyebrow')}
          </p>
          <h1 className="font-brand text-3xl font-medium tracking-tight">
            {t('settings.integrations.screen.title')}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {t('settings.integrations.screen.description')}
          </p>
        </div>
      </header>

      {callbackError ? (
        <div
          role="alert"
          className="mb-6 flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
          {t(`settings.integrations.callback.${callbackError}`)}
        </div>
      ) : null}

      <section aria-labelledby="connected-heading">
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 id="connected-heading" className="text-sm font-semibold">
                {t('settings.integrations.connected.title')}
              </h2>
              {connectedCount > 0 ? (
                <span className="grid min-w-5 place-items-center rounded-full bg-muted px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground">
                  {connectedCount.toLocaleString(resolvedLocale)}
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('settings.integrations.connected.description')}
            </p>
          </div>
        </div>

        {connectionQueriesPending ? (
          <div className="overflow-hidden rounded-xl border bg-card">
            <ListRowsSkeleton rows={2} />
          </div>
        ) : (
          <>
            {integrationsEnabled && mcpQuery.error ? (
              <DataError
                message={t('settings.integrations.connected.mcpLoadError')}
                onRetry={() => void mcpQuery.refetch()}
              />
            ) : null}
            {automationQuery.error ? (
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-warning/25 bg-warning/5 px-4 py-3 text-xs text-warning">
                <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
                {t('settings.integrations.connected.automationLoadError')}
              </div>
            ) : null}
            {connectedCount > 0 ? (
              <ul className="divide-y divide-border/70 overflow-hidden rounded-xl bg-muted py-1">
                {automations.map(automation => (
                  <AutomationConnectionRow key={automation.id} automation={automation} />
                ))}
                {integrationsEnabled
                  ? connectedServers.map(server => (
                      <ServerConnectionRow key={server.id} server={server} />
                    ))
                  : null}
              </ul>
            ) : null}
            {showEmptyConnections ? (
              <div className="flex items-center gap-3 rounded-xl border border-dashed bg-muted/20 px-4 py-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
                  <Cable aria-hidden="true" className="size-4" />
                </span>
                <div>
                  <p className="text-sm font-medium">
                    {t('settings.integrations.connected.emptyTitle')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('settings.integrations.connected.emptyDescription')}
                  </p>
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>

      {integrationsEnabled &&
      !connectionQueriesPending &&
      !mcpQuery.error &&
      setupServers.length > 0 ? (
        <section className="mt-6" aria-labelledby="setup-heading">
          <div className="mb-3">
            <h2 id="setup-heading" className="text-sm font-semibold">
              {t('settings.integrations.setup.title')}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('settings.integrations.setup.description')}
            </p>
          </div>
          <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border bg-card">
            {setupServers.map(server => (
              <ServerConnectionRow key={server.id} server={server} />
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-10" aria-labelledby="methods-heading">
        <div className="mb-3">
          <h2 id="methods-heading" className="text-sm font-semibold">
            {t('settings.integrations.methods.title')}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('settings.integrations.methods.description')}
          </p>
        </div>
        {/*
          Hairline tile strip: the container's `bg-border` shows through the 1px gaps, so an
          unfilled cell renders as a solid grey block rather than empty space. With the custom
          card gated away there are three tiles, not four — let the last one span the leftover
          cell so the row stays flush at both the 2-col and 4-col breakpoints.
        */}
        <div
          className={cn(
            'grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2 xl:grid-cols-4',
            !customServersEnabled && 'sm:[&>*:last-child]:col-span-2'
          )}
        >
          <ConnectionMethodCard
            icon={Braces}
            name={t('settings.integrations.methods.apiName')}
            description={t('settings.integrations.methods.apiDescription')}
            destination={t('settings.integrations.methods.apiDestination')}
            tone="bg-primary/5 text-primary"
            href="/settings/api-keys"
          />
          <ConnectionMethodCard
            icon={KeyRound}
            name={t('settings.integrations.methods.mcpName')}
            description={t('settings.integrations.methods.mcpDescription')}
            destination={t('settings.integrations.methods.mcpDestination')}
            tone="bg-success/10 text-success"
            href="/settings/api-keys"
          />
          {entitlements.features.automations ? (
            <ConnectionMethodCard
              icon={Webhook}
              name={t('settings.integrations.methods.webhookName')}
              description={t('settings.integrations.methods.webhookDescription')}
              destination={t('settings.integrations.actions.newAutomation')}
              tone="bg-blue-500/10 text-blue-700 dark:text-blue-300"
              onClick={() => openAutomation('webhook')}
            />
          ) : (
            // Plan gate (client half): the server refuses creation with AUTOMATIONS_NOT_IN_PLAN
            // and stops fanning out to existing automations regardless.
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              {t('settings.billing.screen.gateAutomations')}{' '}
              <Link href="/settings/billing" className="font-medium text-primary hover:underline">
                {t('settings.billing.screen.gateSeePlans')}
              </Link>
            </p>
          )}
          {customServersEnabled ? (
            <ConnectionMethodCard
              icon={Server}
              name={t('settings.integrations.methods.customName')}
              description={t('settings.integrations.methods.customDescription')}
              destination={t('settings.integrations.actions.advancedSetup')}
              tone="bg-muted text-muted-foreground"
              onClick={() => setAddDialog({ open: true })}
            />
          ) : null}
        </div>
      </section>

      <section className="mt-10" aria-labelledby="catalog-heading">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 id="catalog-heading" className="text-sm font-semibold">
                {t('settings.integrations.catalog.title')}
              </h2>
              <span className="grid min-w-5 place-items-center rounded-full bg-muted px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground">
                {catalog.length.toLocaleString(resolvedLocale)}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('settings.integrations.catalog.description')}
            </p>
          </div>
          <div className="relative w-full sm:w-72">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              name="integration-search"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder={t('settings.integrations.catalog.searchPlaceholder')}
              aria-label={t('settings.integrations.catalog.searchAria')}
              autoComplete="off"
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>

        <div
          className="mb-4 flex gap-1 overflow-x-auto pb-1"
          aria-label={t('settings.integrations.catalog.filterAria')}
        >
          {CATALOG_CATEGORIES.map(categoryKey => (
            <button
              key={categoryKey}
              type="button"
              onClick={() => setCategory(categoryKey)}
              aria-pressed={category === categoryKey}
              className={cn(
                'shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                category === categoryKey
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
            >
              {categoryKey === 'all'
                ? t('settings.integrations.catalog.categories.all')
                : categoryLabel(categoryKey, t)}
            </button>
          ))}
        </div>

        {catalog.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {catalog.map(item => (
              <CatalogCard
                key={item.key}
                item={item}
                server={serverByDirectoryKey.get(item.key)}
                onClick={() => {
                  if (item.kind === 'automation' && item.preset) {
                    openAutomation(item.preset);
                  } else if (item.entry) {
                    setProviderEntry(item.entry);
                  }
                }}
              />
            ))}
            <RequestIntegrationCard />
          </div>
        ) : (
          <div className="rounded-xl border border-dashed p-8 text-center">
            <p className="text-sm font-medium">{t('settings.integrations.catalog.noMatchTitle')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {/* The stock copy points at Advanced setup; when that is gated the only route is mail. */}
              {customServersEnabled
                ? t('settings.integrations.catalog.noMatchDescription')
                : t('settings.integrations.catalog.requestMore.description')}
            </p>
            {customServersEnabled ? (
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => setAddDialog({ open: true })}
              >
                <Server className="size-4" />
                {t('settings.integrations.actions.customMcp')}
              </Button>
            ) : (
              <Button variant="outline" size="sm" className="mt-4" asChild>
                <a href={INTEGRATION_REQUEST_MAILTO}>
                  <Mail className="size-4" />
                  {t('settings.integrations.catalog.actions.requestMore')}
                </a>
              </Button>
            )}
          </div>
        )}
      </section>

      {integrationsEnabled ? (
        <>
          <ProviderDialog
            entry={providerEntry}
            onOpenChange={open => !open && setProviderEntry(undefined)}
          />
          <AddIntegrationDialog
            state={addDialog}
            onOpenChange={open => setAddDialog(current => ({ ...current, open }))}
          />
        </>
      ) : null}
      {automationPreset ? (
        <AutomationDialog
          open
          onOpenChange={open => !open && setAutomationPreset(undefined)}
          preset={automationPreset}
        />
      ) : null}
    </div>
  );
}
