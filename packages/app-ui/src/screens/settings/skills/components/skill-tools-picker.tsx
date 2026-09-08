'use client';

import * as React from 'react';
import { useApplicationLocale } from '@prismical/app-i18n';
import { useTranslation } from 'react-i18next';
import { Plus, Search, X } from 'lucide-react';
import { Badge } from '../../../../ui/badge';
import { Button } from '../../../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../ui/dialog';
import { Input } from '../../../../ui/input';
import { Checkbox } from '../../../../ui/checkbox';
import {
  useFeatureFlag,
  useMcpServer,
  useMcpServers,
  type McpServer,
  type McpTool,
} from '@prismical/app-client';
import { IntegrationLogo } from '../../../../components/integration-brand-mark';

/**
 * Skill "Tools" picker: compact per-server summary rows on the form; all
 * selection happens in a searchable dialog. Grants persist to `skill.allowed_tools` as
 * `mcp:{serverId}:{tool}` or the per-server wildcard `mcp:{serverId}:*` (all tools, including
 * ones added by later refreshes; resolved at run time ∩ the server's enabled tools).
 * Deliberately calm: the allow-list is the consent — one caption, no warning ceremony.
 */

const WILDCARD = '*';

function parseEntry(entry: string): { serverId: string; tool: string } | null {
  const m = /^mcp:([^:]+):(.+)$/.exec(entry);
  return m ? { serverId: m[1]!, tool: m[2]! } : null;
}

/** Grants grouped by server: '*' or the set of exact tool names. */
function groupGrants(value: string[]): Map<string, Set<string> | '*'> {
  const map = new Map<string, Set<string> | '*'>();
  for (const entry of value) {
    const parsed = parseEntry(entry);
    if (!parsed) continue;
    if (parsed.tool === WILDCARD) {
      map.set(parsed.serverId, '*');
    } else if (map.get(parsed.serverId) !== '*') {
      const set = (map.get(parsed.serverId) as Set<string> | undefined) ?? new Set<string>();
      set.add(parsed.tool);
      map.set(parsed.serverId, set);
    }
  }
  return map;
}

function grantsToEntries(grants: Map<string, Set<string> | '*'>): string[] {
  const out: string[] = [];
  for (const [serverId, grant] of grants) {
    if (grant === '*') out.push(`mcp:${serverId}:*`);
    else for (const tool of [...grant].sort()) out.push(`mcp:${serverId}:${tool}`);
  }
  return out.sort();
}

function ToolKindBadge({ tool }: { tool: McpTool }) {
  const { t } = useTranslation();
  const a = tool.annotations;
  if (a?.destructiveHint)
    return <Badge variant="destructive">{t('settings.skillLibrary.tools.destructive')}</Badge>;
  if (a?.readOnlyHint === true)
    return (
      <Badge variant="ghost" className="text-muted-foreground">
        {t('settings.skillLibrary.tools.read')}
      </Badge>
    );
  if (a?.readOnlyHint === false)
    return (
      <Badge variant="outline" className="border-warning/30 bg-warning/10 text-warning">
        {t('settings.skillLibrary.tools.write')}
      </Badge>
    );
  return null;
}

/** One server's group inside the dialog — fetches the tool catalog lazily (cached by react-query). */
function ServerGroup({
  server,
  grant,
  search,
  onChange,
}: {
  server: McpServer;
  grant: Set<string> | '*' | undefined;
  search: string;
  onChange: (grant: Set<string> | '*' | undefined) => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const { data: detail } = useMcpServer(server.id);
  const tools = detail?.tools ?? [];
  const q = search.trim().toLocaleLowerCase(resolvedLocale);
  const visible = q
    ? tools.filter(tool =>
        `${tool.name} ${tool.description ?? ''} ${server.name}`
          .toLocaleLowerCase(resolvedLocale)
          .includes(q)
      )
    : tools;
  if (q && visible.length === 0) return null;

  const isToolOn = (name: string) => grant === '*' || (grant instanceof Set && grant.has(name));

  return (
    <div className="rounded-lg border border-border/60">
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/50 px-3 py-2">
        <IntegrationLogo directoryKey={server.directoryKey} name={server.name} size="xs" />
        <span className="flex-1 text-sm font-medium">{server.name}</span>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox
            checked={grant === '*'}
            onCheckedChange={on => onChange(on ? '*' : undefined)}
          />
          {t('settings.skillLibrary.tools.all')}
        </label>
      </div>
      <div className="max-h-56 divide-y divide-border/40 overflow-y-auto">
        {visible.map(tool => (
          <label key={tool.name} className="flex cursor-pointer items-start gap-2.5 px-3 py-2">
            <Checkbox
              className="mt-0.5"
              checked={isToolOn(tool.name)}
              onCheckedChange={on => {
                const next = new Set<string>(
                  grant === '*' ? tools.map(t => t.name) : [...(grant ?? [])]
                );
                if (on) next.add(tool.name);
                else next.delete(tool.name);
                onChange(next.size === 0 ? undefined : next);
              }}
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <code className="text-xs font-medium">{tool.name}</code>
                <ToolKindBadge tool={tool} />
              </span>
              {tool.description && (
                <span className="block truncate text-xs text-muted-foreground">
                  {tool.description}
                </span>
              )}
            </span>
          </label>
        ))}
        {tools.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {t('settings.skillLibrary.tools.noCached')}
          </p>
        )}
      </div>
    </div>
  );
}

export function SkillToolsPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const { enabled: integrationsEnabled } = useFeatureFlag('integrations');
  const { enabled: skillMcpToolsEnabled } = useFeatureFlag('skillMcpTools');
  const toolsEnabled = integrationsEnabled && skillMcpToolsEnabled;
  const { data: queriedServers } = useMcpServers(toolsEnabled);
  const servers = React.useMemo(
    () => (toolsEnabled ? (queriedServers ?? []) : []),
    [toolsEnabled, queriedServers]
  );
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');

  const grants = React.useMemo(() => groupGrants(value), [value]);
  const serverById = React.useMemo(() => new Map(servers.map(s => [s.id, s])), [servers]);

  const setGrant = (serverId: string, grant: Set<string> | '*' | undefined) => {
    const next = new Map(grants);
    if (grant === undefined) next.delete(serverId);
    else next.set(serverId, grant);
    onChange(grantsToEntries(next));
  };

  const summaryRows = [...grants.entries()].map(([serverId, grant]) => {
    const server = serverById.get(serverId);
    const label =
      grant === '*'
        ? server
          ? t('settings.skillLibrary.tools.allSummary', {
              countLabel: server.toolCount.toLocaleString(resolvedLocale),
            })
          : t('settings.skillLibrary.tools.all')
        : t('settings.skillLibrary.tools.selectedSummary', {
            selectedLabel: grant.size.toLocaleString(resolvedLocale),
            totalLabel: server?.toolCount.toLocaleString(resolvedLocale) ?? '?',
          });
    return { serverId, server, label };
  });

  if (!toolsEnabled) return null;

  return (
    <div className="space-y-2">
      {summaryRows.length > 0 && (
        <div className="divide-y divide-border/50 overflow-hidden rounded-lg bg-muted">
          {summaryRows.map(({ serverId, server, label }) => (
            <div key={serverId} className="flex items-center gap-2.5 px-3 py-2">
              <IntegrationLogo
                directoryKey={server?.directoryKey ?? null}
                name={server?.name ?? t('settings.skillLibrary.tools.unavailable')}
                size="xs"
              />
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">
                  {server?.name ?? t('settings.skillLibrary.tools.unavailable')}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">· {label}</span>
                {!server && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    ({t('settings.skillLibrary.tools.disconnected')})
                  </span>
                )}
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => setDialogOpen(true)}
              >
                {t('settings.skillLibrary.actions.edit')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-muted-foreground"
                aria-label={t('settings.skillLibrary.tools.removeAria', {
                  name: server?.name ?? serverId,
                })}
                onClick={() => setGrant(serverId, undefined)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <Button type="button" size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
        <Plus className="h-3.5 w-3.5" />
        {t('settings.skillLibrary.actions.addTools')}
      </Button>
      <p className="text-xs text-muted-foreground">{t('settings.skillLibrary.tools.safety')}</p>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('settings.skillLibrary.actions.addTools')}</DialogTitle>
            <DialogDescription>
              {t('settings.skillLibrary.tools.dialogDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('settings.skillLibrary.tools.searchPlaceholder')}
              className="h-8 pl-8 text-sm"
            />
          </div>
          <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
            {servers.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                {t('settings.skillLibrary.tools.emptyIntegrations')}
              </p>
            ) : (
              servers.map(server => (
                <ServerGroup
                  key={server.id}
                  server={server}
                  grant={grants.get(server.id)}
                  search={search}
                  onChange={g => setGrant(server.id, g)}
                />
              ))
            )}
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setDialogOpen(false)}>
              {t('settings.skillLibrary.actions.done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
