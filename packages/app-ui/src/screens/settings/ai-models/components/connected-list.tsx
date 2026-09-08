'use client';

import { useFeatureFlags } from '@prismical/app-client';
import { useState } from 'react';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';

import { Button } from '../../../../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../../ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../../ui/alert-dialog';
import type { Instance, InstanceConfig } from '../../mock-data';
import {
  isProviderVisible,
  isProviderType,
  PROVIDER_META,
  PROVIDER_TYPE_COMING_SOON,
  PROVIDER_TYPES,
  type ProviderType,
} from '../../../../lib/providers';

import { ListRowsSkeleton } from '../../../../components/skeletons';

import { useAIModels } from './ai-models-store';
import { useTranslation } from 'react-i18next';

interface ConnectedListProps {
  /** Open the Edit form dialog for this instance id (cloud only). */
  onEdit: (id: string) => void;
}

// Display rank for connected rows. Cloud sits in the middle, Mock is pinned to
// the very end (dev only).
function connectedRank(type: string): number {
  if (type === PROVIDER_TYPES.mock) return 99;
  return 50;
}

// Redacted preview of an instance's credential.
function configPreview(
  type: ProviderType,
  config: InstanceConfig,
  modelCount: (count: number) => string,
  devOnly: string
): string {
  switch (type) {
    case PROVIDER_TYPES.openai:
    case PROVIDER_TYPES.anthropic:
    case PROVIDER_TYPES.groq:
    case PROVIDER_TYPES.openRouter:
    case PROVIDER_TYPES.googleGemini:
    case PROVIDER_TYPES.deepgram: {
      const apiKey = 'apiKey' in config ? config.apiKey : '';
      return apiKey ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : '—';
    }
    case PROVIDER_TYPES.ollama: {
      return 'url' in config ? config.url : '—';
    }
    case PROVIDER_TYPES.openAICompatible: {
      return 'baseURL' in config ? config.baseURL : '—';
    }
    case PROVIDER_TYPES.mock:
      return devOnly;
    default:
      return '';
  }
}

type RemoveTarget = { kind: 'cloud'; instance: Instance };

export default function ConnectedList({ onEdit }: ConnectedListProps) {
  const { t } = useTranslation();
  const { isEnabled } = useFeatureFlags();
  const { instances, loading, removeInstance } = useAIModels();
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);

  const isDev = process.env.NODE_ENV !== 'production';

  // Single ordered list. Local Whisper uses the real on-device model manager
  // through the desktop model-manager port, never a stale server-side instance row.
  const visible = instances
    .filter(i => {
      if (!isProviderVisible(i.provider, isEnabled)) return false;
      if (i.provider === PROVIDER_TYPES.localWhisper) return false;
      if (i.provider === PROVIDER_TYPES.mock) return isDev;
      return true;
    })
    .sort((a, b) => connectedRank(a.provider) - connectedRank(b.provider));

  // Show a skeleton on the first load so the "nothing connected" prompt doesn't
  // flash before the instance list resolves.
  if (loading && instances.length === 0) {
    return (
      <div className="rounded-md border bg-card">
        <ListRowsSkeleton rows={2} />
      </div>
    );
  }

  if (visible.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground italic">
        {t('settings.aiModels.connectedList.empty')}
      </div>
    );
  }

  const handleConfirmRemove = () => {
    if (!removeTarget) return;
    removeInstance(removeTarget.instance.id);
    setRemoveTarget(null);
  };

  return (
    <>
      <div className="rounded-md border divide-y bg-card">
        {visible.map(instance => {
          if (!isProviderType(instance.provider)) return null;
          if (instance.provider === PROVIDER_TYPES.mock) {
            return <MockRow key={instance.id} instance={instance} />;
          }
          // Cloud row: Edit (creds), Delete (instance).
          return (
            <Row
              key={instance.id}
              instance={instance}
              comingSoon={PROVIDER_TYPE_COMING_SOON[instance.provider]}
              onEditClick={() => onEdit(instance.id)}
              onDeleteClick={() => setRemoveTarget({ kind: 'cloud', instance })}
            />
          );
        })}
      </div>

      <AlertDialog
        open={!!removeTarget}
        onOpenChange={open => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <AlertDialogContent>
          {removeTarget !== null && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t('settings.aiModels.connectedList.removeTitle', {
                    name: removeTarget.instance.label,
                  })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t('settings.aiModels.connectedList.removeDescription')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.actions.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleConfirmRemove}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {t('settings.aiModels.connectedList.remove')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface RowProps {
  instance: Instance;
  comingSoon?: boolean;
  onEditClick: () => void;
  onDeleteClick: () => void;
}

function Row({ instance, comingSoon = false, onEditClick, onDeleteClick }: RowProps) {
  const { t } = useTranslation();
  if (!isProviderType(instance.provider)) return null;
  const meta = PROVIDER_META[instance.provider];
  const preview = configPreview(
    instance.provider,
    instance.config,
    count => t('settings.aiModels.connectedList.modelCount', { count }),
    t('settings.aiModels.connectedList.devOnly')
  );
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-accent">
      <meta.Logo className={`size-4 shrink-0 ${meta.tint ?? ''}`} />
      <span className="text-sm font-medium truncate flex-1 min-w-0">
        {meta.label}
        <span className="text-muted-foreground"> · {instance.label}</span>
      </span>
      {comingSoon && (
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {t('settings.aiModels.available.comingSoon')}
        </span>
      )}
      <span className="text-xs text-muted-foreground truncate font-mono shrink-0 max-w-[40%]">
        {preview}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            aria-label={t('settings.aiModels.connectedList.optionsAria', {
              name: instance.label,
            })}
          >
            {comingSoon ? <MoreHorizontal className="size-3.5" /> : <Pencil className="size-3.5" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          {!comingSoon && (
            <>
              <DropdownMenuItem onClick={onEditClick}>
                <Pencil className="mr-2 size-3.5" />
                {t('common.actions.edit')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem
            onClick={onDeleteClick}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 size-3.5" />
            {t('common.actions.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

interface MockRowProps {
  instance: Instance;
}

// Mock has no actions worth surfacing — render the row, skip the menu.
function MockRow({ instance }: MockRowProps) {
  const { t } = useTranslation();
  if (!isProviderType(instance.provider)) return null;
  const meta = PROVIDER_META[instance.provider];
  const preview = configPreview(
    instance.provider,
    instance.config,
    count => t('settings.aiModels.connectedList.modelCount', { count }),
    t('settings.aiModels.connectedList.devOnly')
  );

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-accent">
      <meta.Logo className={`size-4 shrink-0 ${meta.tint ?? ''}`} />
      <span className="text-sm font-medium truncate flex-1 min-w-0">{meta.label}</span>
      <span className="text-xs text-muted-foreground truncate shrink-0 max-w-[40%]">{preview}</span>
    </div>
  );
}
