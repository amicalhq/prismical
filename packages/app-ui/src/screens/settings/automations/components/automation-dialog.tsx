'use client';

import * as React from 'react';
import {
  Check,
  Copy,
  Folder as FolderIcon,
  Loader2,
  Tag as TagIcon,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../../../ui/button';
import { copyToClipboard } from '../../../../lib/clipboard';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../ui/dialog';
import { Input } from '../../../../ui/input';
import { Label } from '../../../../ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../ui/select';
import { Switch } from '../../../../ui/switch';
import { useFolders } from '@prismical/app-client';
import { useTags } from '@prismical/app-client';
import {
  useCreateAutomation,
  useUpdateAutomation,
  type Automation,
  type AutomationEventType,
  type AutomationInput,
} from '@prismical/app-client';
import { EVENT_TYPE_OPTIONS, eventTypeLabel } from './automation-format';
import { ScopeMultiPicker } from './scope-multi-picker';
import { useTranslation } from 'react-i18next';

export type AutomationPreset = 'webhook' | 'zapier' | 'n8n' | 'activepieces' | 'make';

interface AutomationPresetMeta {
  provider: string;
  urlPlaceholder: string;
}

const AUTOMATION_PRESETS: Record<AutomationPreset, AutomationPresetMeta> = {
  webhook: {
    provider: '',
    urlPlaceholder: 'https://api.example.com/webhooks/prismical',
  },
  zapier: {
    provider: 'Zapier',
    urlPlaceholder: 'https://hooks.zapier.com/hooks/catch/…',
  },
  n8n: {
    provider: 'n8n',
    urlPlaceholder: 'https://your-n8n.example/webhook/…',
  },
  activepieces: {
    provider: 'Activepieces',
    urlPlaceholder: 'https://cloud.activepieces.com/api/v1/webhooks/…',
  },
  make: {
    provider: 'Make',
    urlPlaceholder: 'https://hook.us1.make.com/…',
  },
};

/**
 * The builder (create + edit): When (event + folder/tag scope, multi-select with "Any"
 * defaults) → Then (send_webhook: endpoint URL). After a create, the dialog flips to a
 * secret-reveal step showing the whsec_ signing secret (also revealable later from the detail
 * page — Stripe semantics, not show-once).
 */
export function AutomationDialog({
  open,
  onOpenChange,
  automation,
  preset = 'webhook',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present = edit mode. */
  automation?: Automation | null;
  /** Create-mode presentation. Every provider preset remains a signed webhook under the hood. */
  preset?: AutomationPreset;
}) {
  const { t, i18n } = useTranslation();
  const isEdit = Boolean(automation);
  const presetMeta = AUTOMATION_PRESETS[preset];
  const presetProvider =
    preset === 'webhook' ? t('settings.automations.dialog.webhookName') : presetMeta.provider;
  const { data: folders = [] } = useFolders();
  const { data: tags = [] } = useTags();
  const createMut = useCreateAutomation();
  const updateMut = useUpdateAutomation({ silent: true }); // errors render inline below

  const [name, setName] = React.useState('');
  // The FULL event-type set. The single-select shows the first; picking a new value replaces
  // the whole set deliberately, but an untouched select preserves a multi-event automation
  // (creatable via the API) instead of silently collapsing it to one type on save.
  const [eventTypes, setEventTypes] = React.useState<AutomationEventType[]>([
    'recording.transcribed',
  ]);
  const [folderIds, setFolderIds] = React.useState<string[]>([]);
  const [tagIds, setTagIds] = React.useState<string[]>([]);
  const [url, setUrl] = React.useState('');
  const [enabled, setEnabled] = React.useState(true);
  const [error, setError] = React.useState(false);
  const [createdSecret, setCreatedSecret] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  // (Re)seed form state each time the dialog opens. Keyed on the automation's ID (not object
  // identity) so a background refetch mid-edit can't wipe in-progress input.
  React.useEffect(() => {
    if (!open) return;
    setError(false);
    setCreatedSecret(null);
    setCopied(false);
    setName(
      automation?.name ??
        (preset === 'webhook'
          ? ''
          : t('settings.automations.dialog.defaultName', { provider: presetProvider }))
    );
    setEventTypes(
      automation?.triggerConfig.eventTypes?.length
        ? automation.triggerConfig.eventTypes
        : ['recording.transcribed']
    );
    setFolderIds(automation?.triggerConfig.filter?.folderIds ?? []);
    setTagIds(automation?.triggerConfig.filter?.tagIds ?? []);
    setUrl(automation?.actionConfig.url ?? '');
    setEnabled(automation?.enabled ?? true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reseed only on open/target change
  }, [open, automation?.id, preset]);

  const pending = createMut.isPending || updateMut.isPending;
  const canSubmit = name.trim().length > 0 && url.trim().length > 0 && !pending;

  const buildInput = (): AutomationInput => {
    // Drop filter refs whose folder/tag has since been deleted — the server 404s unknown refs,
    // and the pickers can't even show them. Only prune against a LOADED list (an in-flight
    // query must not wipe a valid filter).
    const liveFolderIds = folders.length
      ? folderIds.filter(id => folders.some(f => f.id === id))
      : folderIds;
    const liveTagIds = tags.length ? tagIds.filter(id => tags.some(t => t.id === id)) : tagIds;
    return {
      name: name.trim(),
      triggerConfig: {
        eventTypes,
        ...(liveFolderIds.length || liveTagIds.length
          ? {
              filter: {
                ...(liveFolderIds.length ? { folderIds: liveFolderIds } : {}),
                ...(liveTagIds.length ? { tagIds: liveTagIds } : {}),
              },
            }
          : {}),
      },
      actionType: 'send_webhook',
      actionConfig: { url: url.trim() },
      enabled,
    };
  };

  const submit = async () => {
    if (!canSubmit) return;
    setError(false);
    try {
      if (isEdit && automation) {
        // actionType is immutable server-side and the PATCH schema is strict — omit it.
        const input = buildInput();
        const patch = {
          name: input.name,
          triggerConfig: input.triggerConfig,
          actionConfig: input.actionConfig,
          enabled: input.enabled,
        };
        await updateMut.mutateAsync({ id: automation.id, patch });
        toast.success(t('settings.automations.dialog.updated'));
        onOpenChange(false);
      } else {
        const created = await createMut.mutateAsync(buildInput());
        setCreatedSecret(created.secret);
      }
    } catch {
      setError(true);
    }
  };

  const copySecret = async () => {
    if (!createdSecret) return;
    if (await copyToClipboard(createdSecret)) {
      setCopied(true);
      toast.success(t('settings.automations.secret.copied'));
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error(t('settings.automations.secret.copyError'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[540px]">
        {createdSecret ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('settings.automations.dialog.createdTitle')}</DialogTitle>
              <DialogDescription>
                {t('settings.automations.dialog.createdDescription')}
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs">
                {createdSecret}
              </code>
              <Button variant="outline" size="sm" onClick={copySecret}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {t('common.actions.copy')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('settings.automations.dialog.verifyPrefix')}{' '}
              <code className="font-mono">Prismical-Signature</code>{' '}
              {t('settings.automations.dialog.verifySuffix')}{' '}
              <code className="font-mono">{'`${t}.${body}`'}</code>.
            </p>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>{t('common.actions.done')}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {isEdit
                  ? t('settings.automations.dialog.editTitle')
                  : t('settings.automations.dialog.newTitle', { provider: presetProvider })}
              </DialogTitle>
              <DialogDescription>
                {isEdit
                  ? t('settings.automations.dialog.editDescription')
                  : preset === 'webhook'
                    ? t('settings.automations.dialog.webhookDescription')
                    : t('settings.automations.dialog.newDescription', {
                        provider: presetProvider,
                      })}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="automation-name">{t('settings.automations.dialog.name')}</Label>
                <Input
                  id="automation-name"
                  name="automation-name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={
                    preset === 'webhook'
                      ? t('settings.automations.dialog.namePlaceholder')
                      : t('settings.automations.dialog.defaultName', { provider: presetProvider })
                  }
                  autoComplete="off"
                  maxLength={120}
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <Label
                  id="automation-event-type-label"
                  className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {t('settings.automations.dialog.when')}
                </Label>
                <div className="space-y-2">
                  <Select
                    value={eventTypes[0]}
                    onValueChange={v => setEventTypes([v as AutomationEventType])}
                  >
                    <SelectTrigger className="w-full" aria-labelledby="automation-event-type-label">
                      <Zap aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EVENT_TYPE_OPTIONS.map(eventType => (
                        <SelectItem key={eventType} value={eventType}>
                          {eventTypeLabel(eventType, t)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {eventTypes.length > 1 ? (
                    <p className="text-xs text-muted-foreground">
                      {t('settings.automations.dialog.alsoFires', {
                        events: new Intl.ListFormat(i18n.resolvedLanguage ?? 'en').format(
                          eventTypes.slice(1).map(eventType => eventTypeLabel(eventType, t))
                        ),
                      })}
                    </p>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2">
                    <ScopeMultiPicker
                      options={folders.map(f => ({ id: f.id, label: f.name }))}
                      value={folderIds}
                      onChange={setFolderIds}
                      anyLabel={t('settings.automations.dialog.anyFolder')}
                      searchPlaceholder={t('settings.automations.dialog.searchFolders')}
                      icon={FolderIcon}
                    />
                    <ScopeMultiPicker
                      options={tags.map(t => ({ id: t.id, label: t.name, color: t.color }))}
                      value={tagIds}
                      onChange={setTagIds}
                      anyLabel={t('settings.automations.dialog.anyTag')}
                      searchPlaceholder={t('settings.automations.dialog.searchTags')}
                      icon={TagIcon}
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label
                  htmlFor="automation-destination-url"
                  className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {isEdit || preset === 'webhook'
                    ? t('settings.automations.dialog.destinationWebhook')
                    : t('settings.automations.dialog.destination', { provider: presetProvider })}
                </Label>
                <Input
                  id="automation-destination-url"
                  name="automation-destination-url"
                  type="url"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder={presetMeta.urlPlaceholder}
                  autoComplete="url"
                  spellCheck={false}
                  aria-describedby="automation-destination-help"
                  className="font-mono text-xs"
                  onKeyDown={e => e.key === 'Enter' && void submit()}
                />
                <p id="automation-destination-help" className="text-xs text-muted-foreground">
                  {isEdit || preset === 'webhook'
                    ? t('settings.automations.dialog.helperWebhook')
                    : t('settings.automations.dialog.helper', { provider: presetProvider })}
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <div id="automation-enabled-label" className="text-sm font-medium">
                    {t('settings.automations.dialog.enableNow')}
                  </div>
                  <div
                    id="automation-enabled-description"
                    className="text-xs text-muted-foreground"
                  >
                    {t('settings.automations.dialog.enableDescription')}
                  </div>
                </div>
                <Switch
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  aria-labelledby="automation-enabled-label"
                  aria-describedby="automation-enabled-description"
                />
              </div>

              {error ? (
                <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
                  <TriangleAlert aria-hidden="true" className="h-4 w-4 shrink-0" />
                  {t('settings.automations.dialog.error')}
                </p>
              ) : null}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                {t('common.actions.cancel')}
              </Button>
              <Button onClick={() => void submit()} disabled={!canSubmit}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {isEdit
                  ? t('settings.automations.dialog.saveChanges')
                  : t('settings.automations.dialog.createAction')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
