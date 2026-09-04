'use client';

import * as React from 'react';
import { KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';
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
import { DataError } from '../../../components/data-error';
import { ListRowsSkeleton } from '../../../components/skeletons';
import { useApiKeys, useRevokeApiKey, type ApiKey } from '@prismical/app-client';
import { DocsLink } from './docs-link';
import { API_BASE_URL, API_DOCS_URL } from './mcp-clients';
import { useTranslation } from 'react-i18next';

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

type KeyStatus = 'active' | 'expiring' | 'expired';

function keyStatus(key: ApiKey): KeyStatus {
  if (!key.expiresAt) return 'active';
  const exp = new Date(key.expiresAt).getTime();
  if (exp <= Date.now()) return 'expired';
  if (exp - Date.now() <= 14 * DAY_MS) return 'expiring';
  return 'active';
}

function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatRelative(iso: string, locale: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (ms < 60_000) return relative.format(0, 'second');
  const m = Math.floor(ms / 60_000);
  if (m < 60) return relative.format(-m, 'minute');
  const h = Math.floor(m / 60);
  if (h < 24) return relative.format(-h, 'hour');
  const d = Math.floor(h / 24);
  if (d < 30) return relative.format(-d, 'day');
  return formatDate(iso, locale);
}

/** Display token: the stored leading chars (incl. prefix) + a masked tail. */
function maskedKey(key: ApiKey): string {
  return `${key.start ?? key.prefix ?? 'prsm_'}••••`;
}

// Active first, expired last; newest within each group.
function sortKeys(keys: ApiKey[]): ApiKey[] {
  return [...keys].sort((a, b) => {
    const ae = keyStatus(a) === 'expired' ? 1 : 0;
    const be = keyStatus(b) === 'expired' ? 1 : 0;
    if (ae !== be) return ae - be;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

// ─── Status badge ───────────────────────────────────────────────────────────

function StatusBadge({ keyItem }: { keyItem: ApiKey }) {
  const { t } = useTranslation();
  const status = keyStatus(keyItem);
  if (status === 'expired') {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {t('settings.apiMcp.keys.expired')}
      </Badge>
    );
  }
  if (status === 'expiring') {
    const daysLeft = Math.max(
      1,
      Math.ceil((new Date(keyItem.expiresAt!).getTime() - Date.now()) / DAY_MS)
    );
    return (
      <Badge variant="outline" className="border-warning/30 bg-warning/10 text-warning">
        {t('settings.apiMcp.keys.expiresIn', { count: daysLeft })}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-success/30 bg-success/10 text-success">
      {t('settings.apiMcp.keys.active')}
    </Badge>
  );
}

// ─── Key row ──────────────────────────────────────────────────────────────────

function ApiKeyRow({ keyItem, onRevoke }: { keyItem: ApiKey; onRevoke: (key: ApiKey) => void }) {
  const { t, i18n } = useTranslation();
  const expired = keyStatus(keyItem) === 'expired';
  const locale = i18n.resolvedLanguage ?? 'en';
  const expiry = !keyItem.expiresAt
    ? t('settings.apiMcp.keys.neverExpires')
    : t(
        keyStatus(keyItem) === 'expired'
          ? 'settings.apiMcp.keys.expiredDate'
          : 'settings.apiMcp.keys.expiresDate',
        { date: formatDate(keyItem.expiresAt, locale) }
      );
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <KeyRound
        className="h-[18px] w-[18px] shrink-0 text-muted-foreground"
        style={{ opacity: expired ? 0.55 : 1 }}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={
              'text-sm font-medium leading-tight ' + (expired ? 'text-muted-foreground' : '')
            }
          >
            {keyItem.name}
          </span>
          <StatusBadge keyItem={keyItem} />
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-2xs text-foreground">
            {maskedKey(keyItem)}
          </code>
          <span className="opacity-60">&middot;</span>
          <span>
            {t('settings.apiMcp.keys.created', {
              date: formatDate(keyItem.createdAt, locale),
            })}
          </span>
          <span className="opacity-60">&middot;</span>
          <span>
            {keyItem.lastRequest
              ? t('settings.apiMcp.keys.lastUsed', {
                  time: formatRelative(keyItem.lastRequest, locale),
                })
              : t('settings.apiMcp.keys.neverUsed')}
          </span>
          <span className="opacity-60">&middot;</span>
          <span>{expiry}</span>
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
        onClick={() => onRevoke(keyItem)}
      >
        <Trash2 className="h-3.5 w-3.5" />
        {t('settings.apiMcp.keys.revoke')}
      </Button>
    </div>
  );
}

// ─── Revoke confirm ─────────────────────────────────────────────────────────

function RevokeDialog({
  keyItem,
  onOpenChange,
  onRevoked,
}: {
  keyItem: ApiKey | null;
  onOpenChange: (open: boolean) => void;
  onRevoked: (id: string) => void;
}) {
  const { t } = useTranslation();
  const revoke = useRevokeApiKey();

  // Clear any error/pending state from a previous target when this dialog
  // re-opens, so reopening for a different key doesn't flash a stale state.
  React.useEffect(() => {
    if (keyItem) revoke.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyItem]);

  const handleConfirm = () => {
    if (!keyItem) return;
    const { id } = keyItem;
    revoke.mutate(id, {
      onSuccess: () => {
        onOpenChange(false);
        onRevoked(id);
      },
    });
  };

  return (
    <Dialog open={keyItem !== null} onOpenChange={next => !revoke.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('settings.apiMcp.keys.revokeTitle', { name: keyItem?.name ?? '' })}
          </DialogTitle>
          <DialogDescription>{t('settings.apiMcp.keys.revokeDescription')}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={revoke.isPending}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={revoke.isPending}>
            {revoke.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {revoke.isPending
              ? t('settings.apiMcp.keys.revoking')
              : t('settings.apiMcp.keys.revokeAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Section ─────────────────────────────────────────────────────────────────

/**
 * The key list. Creation lives on the parent screen because the MCP setup
 * section above mints keys through the same dialog — one key
 * implementation, two entry points.
 */
export function ApiKeysSection({
  onCreateKey,
  onKeyRevoked,
}: {
  onCreateKey: () => void;
  /** Lets the parent drop a revoked key from the MCP snippets above. */
  onKeyRevoked: (id: string) => void;
}) {
  const { t } = useTranslation();
  const query = useApiKeys();
  const { data: keys, isLoading, error } = query;
  const [revokeTarget, setRevokeTarget] = React.useState<ApiKey | null>(null);

  const sorted = React.useMemo(() => sortKeys(keys ?? []), [keys]);
  const hasKeys = sorted.length > 0;

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{t('settings.apiMcp.keys.title')}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {t('settings.apiMcp.keys.description', { url: API_BASE_URL })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <DocsLink href={API_DOCS_URL} label={t('settings.apiMcp.keys.apiReference')} />
          {hasKeys && (
            <Button onClick={onCreateKey}>
              <Plus className="h-4 w-4" />
              {t('settings.apiMcp.create.action')}
            </Button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="overflow-hidden rounded-xl bg-muted">
          <ListRowsSkeleton rows={2} />
        </div>
      ) : error ? (
        <DataError
          message={t('settings.apiMcp.keys.loadError')}
          onRetry={() => void query.refetch()}
        />
      ) : !hasKeys ? (
        <div className="space-y-4 rounded-lg border border-dashed p-9 text-center">
          <KeyRound className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('settings.apiMcp.keys.emptyTitle')}</p>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              {t('settings.apiMcp.keys.emptyDescription')}
            </p>
          </div>
          <Button onClick={onCreateKey} className="mx-auto">
            <Plus className="h-4 w-4" />
            {t('settings.apiMcp.create.action')}
          </Button>
        </div>
      ) : (
        <div className="divide-y divide-border/50 overflow-hidden rounded-xl bg-muted">
          {sorted.map(keyItem => (
            <ApiKeyRow key={keyItem.id} keyItem={keyItem} onRevoke={setRevokeTarget} />
          ))}
        </div>
      )}

      <RevokeDialog
        keyItem={revokeTarget}
        onOpenChange={open => !open && setRevokeTarget(null)}
        onRevoked={onKeyRevoked}
      />
    </section>
  );
}
