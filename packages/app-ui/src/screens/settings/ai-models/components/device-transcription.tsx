'use client';

import { AlertTriangle, Laptop } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../../../shell/app-link';
import { Badge } from '../../../../ui/badge';

export interface DeviceTranscription {
  models: readonly { id: string; name: string; installed: boolean }[];
  active: boolean;
  loading: boolean;
  /** The active local model, or null when on-device transcription is inactive. */
  selectedModelId: string | null;
  onSelect: (id: string) => void;
}

export function DeviceTranscriptionSummary({ device }: { device: DeviceTranscription }) {
  const { t } = useTranslation();
  const selected = device.models.find(model => model.id === device.selectedModelId);
  if (device.loading) return <p className="text-sm text-muted-foreground">{t('common.status.loading')}</p>;
  return selected?.installed ? (
    <div className="flex items-center gap-2.5 rounded-md border bg-muted p-3">
      <Laptop className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="text-sm font-semibold truncate">{selected.name}</div>
        <div className="text-xs text-muted-foreground">{t('settings.aiModels.deviceTranscription.onDevice')}</div>
      </div>
    </div>
  ) : (
    <div className="flex items-start gap-2.5 rounded-md border border-warning/30 bg-warning/5 p-3">
      <AlertTriangle className="size-4 shrink-0 text-warning mt-0.5" />
      <div>
        <p className="text-sm font-medium text-warning">{t('settings.aiModels.deviceTranscription.missingTitle')}</p>
        <p className="text-xs text-muted-foreground">{t('settings.aiModels.deviceTranscription.missingDescription')}</p>
      </div>
    </div>
  );
}

/** Installed choices only. Downloads and removal stay in the desktop model manager. */
export function DeviceTranscriptionChoices({
  device,
  onSelected,
}: {
  device: DeviceTranscription;
  onSelected?: () => void;
}) {
  const { t } = useTranslation();
  const installed = device.models.filter(model => model.installed);
  return (
    <div className="space-y-2">
      <div className="rounded-md border divide-y bg-card">
        {device.loading ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">{t('common.status.loading')}</p>
        ) : installed.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">{t('settings.aiModels.deviceTranscription.noModels')}</p>
        ) : installed.map(model => (
          <button
            type="button"
            key={model.id}
            onClick={() => { device.onSelect(model.id); onSelected?.(); }}
            className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent"
          >
            <Laptop className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium truncate">{model.name}</span>
              <span className="block text-xs text-muted-foreground">{t('settings.aiModels.deviceTranscription.onDevice')}</span>
            </span>
            {device.active && device.selectedModelId === model.id && (
              <Badge variant="secondary">{t('settings.aiModels.current')}</Badge>
            )}
          </button>
        ))}
      </div>
      <AppLink href="/settings/local-models" onClick={onSelected} className="text-sm text-primary hover:underline">
        {t('settings.aiModels.deviceTranscription.manage')}
      </AppLink>
    </div>
  );
}
