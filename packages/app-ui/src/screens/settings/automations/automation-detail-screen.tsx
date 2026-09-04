'use client';

import * as React from 'react';
import { AppLink as Link } from '../../../shell/app-link';
import { ArrowLeft, Check, Copy, Eye, EyeOff, Loader2, RotateCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
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
import { copyToClipboard } from '../../../lib/clipboard';
import { DataError } from '../../../components/data-error';
import { ListRowsSkeleton } from '../../../components/skeletons';
import { useFolders } from '@prismical/app-client';
import { useTags } from '@prismical/app-client';
import {
  useAutomation,
  useAutomationRuns,
  useAutomationSecret,
  useDeleteAutomation,
  useNavigation,
  useRetryAutomationRun,
  useRotateAutomationSecret,
  useUpdateAutomation,
  type AutomationRun,
} from '@prismical/app-client';
import { AutomationDialog } from './components/automation-dialog';
import { useTranslation } from 'react-i18next';
import type { ApplicationTFunction } from '@prismical/app-i18n';
import {
  automationSentence,
  eventTypeLabel,
  timeAgo,
  timeUntil,
} from './components/automation-format';

function RunBadge({ run }: { run: AutomationRun }) {
  const { t } = useTranslation();
  switch (run.status) {
    case 'succeeded':
      return (
        <Badge variant="outline" className="border-success/30 bg-success/10 text-success">
          {t('settings.automations.runs.delivered')}
        </Badge>
      );
    case 'failed':
      return (
        <Badge
          variant="outline"
          className="border-destructive/30 bg-destructive/10 text-destructive"
        >
          {t('settings.automations.runs.failed')}
        </Badge>
      );
    case 'running':
      return (
        <Badge variant="outline">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('settings.automations.runs.delivering')}
        </Badge>
      );
    default:
      return run.attempts > 0 ? (
        <Badge variant="outline" className="border-warning/30 bg-warning/10 text-warning">
          {t('settings.automations.runs.retrying')}
        </Badge>
      ) : (
        <Badge variant="outline">{t('settings.automations.runs.queued')}</Badge>
      );
  }
}

function runMeta(run: AutomationRun, t: ApplicationTFunction, locale: string): string {
  const parts: string[] = [timeAgo(run.createdAt, locale)];
  const status = run.detail?.responseStatus;
  if (typeof status === 'number') parts.push(`HTTP ${status}`);
  if (typeof run.detail?.durationMs === 'number') {
    parts.push(
      t('settings.automations.runs.duration', {
        duration: run.detail.durationMs.toLocaleString(locale),
      })
    );
  }
  if (run.status === 'pending' && run.attempts > 0)
    parts.push(
      t('settings.automations.runs.nextAttempt', {
        time: timeUntil(run.nextAttemptAt, locale),
      })
    );
  if (run.attempts > 0) {
    parts.push(
      t('settings.automations.runs.attempt', {
        count: run.attempts.toLocaleString(locale),
      })
    );
  }
  return parts.filter(Boolean).join(' · ');
}

// `detail` is an opaque JSON blob in the contract (`z.record(z.string(), z.unknown())`), so walk to
// `detail.event.type` defensively rather than asserting a shape the schema doesn't promise.
function runEventType(run: AutomationRun): string | undefined {
  const event = run.detail?.event;
  if (typeof event !== 'object' || event === null) return undefined;
  const type = (event as Record<string, unknown>).type;
  return typeof type === 'string' ? type : undefined;
}

function RunRow({ run, automationId }: { run: AutomationRun; automationId: string }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const retryMut = useRetryAutomationRun(automationId);
  const eventType = runEventType(run);
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <RunBadge run={run} />
        <div className="min-w-0 flex-1 truncate text-sm">
          {eventType ? (
            <code className="mr-2 rounded bg-secondary px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
              {eventType}
            </code>
          ) : null}
          <span className="text-muted-foreground">
            {eventTypeLabel(eventType ?? 'delivery', t)}
          </span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {runMeta(run, t, i18n.resolvedLanguage ?? 'en')}
        </span>
        {run.error ? (
          <button
            type="button"
            className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => setOpen(v => !v)}
          >
            {t('settings.automations.runs.details')} {open ? '▴' : '▾'}
          </button>
        ) : null}
      </div>
      {open && run.error ? (
        <div className="mt-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs">
          <code className="rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-destructive">
            {run.error.code}
          </code>
          <p className="mt-1.5 text-muted-foreground">
            {t('settings.automations.runs.failureMessage')}
          </p>
          {typeof run.detail?.responseBodyExcerpt === 'string' ? (
            <pre className="mt-1.5 max-h-24 overflow-auto rounded bg-secondary p-2 font-mono text-2xs">
              {run.detail.responseBodyExcerpt}
            </pre>
          ) : null}
          {run.status === 'failed' ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={retryMut.isPending}
              onClick={() => retryMut.mutate(run.id)}
            >
              <RotateCw className="h-3.5 w-3.5" />
              {retryMut.isPending
                ? t('settings.automations.runs.replaying')
                : t('settings.automations.runs.replay')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SecretRow({ automationId }: { automationId: string }) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const secretQuery = useAutomationSecret(automationId, revealed);
  const rotateMut = useRotateAutomationSecret(automationId);
  const secret = secretQuery.data?.secret;

  const copy = async () => {
    if (!secret) return;
    if (await copyToClipboard(secret)) {
      setCopied(true);
      toast.success(t('settings.automations.secret.copied'));
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error(t('settings.automations.secret.copyError'));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{t('settings.automations.secret.label')}</span>
      <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-2xs">
        {revealed && secret ? secret : 'whsec_••••••••••••'}
      </code>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1.5"
        onClick={() => setRevealed(v => !v)}
        aria-label={t(
          revealed ? 'settings.automations.secret.hide' : 'settings.automations.secret.reveal'
        )}
      >
        {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </Button>
      {revealed && secret ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5"
          onClick={copy}
          aria-label={t('settings.automations.secret.copy')}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1.5"
        disabled={rotateMut.isPending}
        onClick={() =>
          rotateMut.mutate(undefined, {
            onSuccess: () => {
              setRevealed(true);
              toast.success(t('settings.automations.secret.rotated'));
            },
          })
        }
      >
        <RotateCw className="h-3.5 w-3.5" />
        {t('settings.automations.secret.rotate')}
      </Button>
    </div>
  );
}

export function AutomationDetailScreen({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const router = useNavigation();
  const { data: automation, isPending, isError, refetch } = useAutomation(id);
  const runsQuery = useAutomationRuns(id);
  const { data: folders = [] } = useFolders();
  const { data: tags = [] } = useTags();
  const updateMut = useUpdateAutomation();
  const deleteMut = useDeleteAutomation();
  const [editOpen, setEditOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  if (isPending) {
    return (
      <div className="mx-auto w-full max-w-4xl">
        <div className="overflow-hidden rounded-xl bg-muted">
          <ListRowsSkeleton rows={3} />
        </div>
      </div>
    );
  }
  if (isError || !automation) {
    return (
      <div className="mx-auto w-full max-w-4xl">
        <DataError
          message={t('settings.automations.detail.loadError')}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const runs = runsQuery.data?.results ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl">
      <Link
        href="/settings/integrations"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('settings.automations.detail.back')}
      </Link>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold">{automation.name}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {automationSentence(automation, folders, tags, t, i18n.resolvedLanguage ?? 'en')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            checked={automation.enabled}
            onCheckedChange={enabled => updateMut.mutate({ id: automation.id, patch: { enabled } })}
            aria-label={t(
              automation.enabled
                ? 'settings.automations.detail.pauseAria'
                : 'settings.automations.detail.enableAria'
            )}
          />
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            {t('common.actions.edit')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="h-4 w-4" />
            {t('common.actions.delete')}
          </Button>
        </div>
      </div>

      <div className="mb-6 space-y-2 rounded-xl border p-4">
        <div className="break-all text-xs text-muted-foreground">
          {t('settings.automations.detail.endpoint')}{' '}
          <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-2xs text-foreground">
            {automation.actionConfig.url}
          </code>
        </div>
        <SecretRow automationId={automation.id} />
        <div className="text-xs text-muted-foreground">
          {t('settings.automations.detail.created', {
            time: timeAgo(automation.createdAt, i18n.resolvedLanguage ?? 'en'),
          })}
          {automation.lastFiredAt ? (
            <>
              {' · '}
              {t('settings.automations.detail.lastDelivery', {
                time: timeAgo(automation.lastFiredAt, i18n.resolvedLanguage ?? 'en'),
              })}
            </>
          ) : null}
        </div>
      </div>

      <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
        {t('settings.automations.detail.runHistory')}
      </h2>
      {runsQuery.isPending ? (
        <div className="overflow-hidden rounded-xl bg-muted">
          <ListRowsSkeleton rows={3} />
        </div>
      ) : runs.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t('settings.automations.detail.emptyRuns')}
        </div>
      ) : (
        <div className="divide-y divide-border/50 overflow-hidden rounded-xl bg-muted">
          {runs.map(run => (
            <RunRow key={run.id} run={run} automationId={automation.id} />
          ))}
        </div>
      )}

      <AutomationDialog open={editOpen} onOpenChange={setEditOpen} automation={automation} />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings.automations.detail.deleteTitle', { name: automation.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.automations.detail.deleteDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMut.isPending}>
              {t('common.actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteMut.isPending}
              onClick={() =>
                deleteMut.mutate(id, {
                  onSuccess: () => router.push('/settings/integrations'),
                })
              }
            >
              {deleteMut.isPending
                ? t('settings.automations.detail.deleting')
                : t('settings.automations.detail.deleteAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
