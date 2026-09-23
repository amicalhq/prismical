/**
 * The on-device Whisper model manager downloads and removes local models.
 * Built from app-ui primitives over
 * DesktopCapabilityPort.localModels (window.desktop.models in the adapter).
 *
 * Per row, local model states are: not installed → Download;
 * downloading → progress + Cancel; verifying/cancelling → status; error →
 * message + Retry + Dismiss (cancel clears an error entry); installed → Delete
 * behind a confirm. Selecting an installed model makes it the transcription
 * engine for this desktop (null modelId means the default model).
 */
import * as React from 'react';
import { DEFAULT_LOCAL_MODEL_ID } from '@prismical/desktop-contracts';
import type { TranscriptionSetting } from '@prismical/app-contracts';
import { useTranslation } from 'react-i18next';
import type {
  LocalModel,
  LocalModelDownload,
  LocalModelDownloadError,
} from '@prismical/app-contracts';
import { useDesktopCapabilities } from '@prismical/app-client';
import { useDesktopEnv } from '../desktop-env';
import {
  formatApplicationBytes,
  useApplicationLocale,
  type SupportedLocale,
} from '@prismical/app-i18n';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@prismical/app-ui/ui/alert-dialog';
import { Badge } from '@prismical/app-ui/ui/badge';
import { Button } from '@prismical/app-ui/ui/button';
import { Card, CardContent } from '@prismical/app-ui/ui/card';
import { useLocalModels } from './use-local-models';

// The wire error set → catalog keys (hyphenated ids are not catalog keys).
const ERROR_KEYS = {
  network: 'network',
  'checksum-mismatch': 'checksumMismatch',
  'insufficient-space': 'insufficientSpace',
  io: 'io',
} as const satisfies Record<LocalModelDownloadError, string>;


function DownloadStatus({
  download,
  locale,
}: {
  download: LocalModelDownload;
  locale: SupportedLocale;
}) {
  const { t } = useTranslation();
  switch (download.status) {
    case 'downloading': {
      const percent =
        download.totalBytes > 0
          ? Math.min(100, Math.floor((download.bytesDownloaded / download.totalBytes) * 100))
          : 0;
      return (
        <div className="space-y-1" data-testid="local-model-progress">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 w-56 max-w-full overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">
            {t('desktop.localModels.downloading', {
              downloaded: formatApplicationBytes(download.bytesDownloaded, locale),
              total: formatApplicationBytes(download.totalBytes, locale),
              percent,
            })}
          </p>
        </div>
      );
    }
    case 'verifying':
      return <p className="text-xs text-muted-foreground">{t('desktop.localModels.verifying')}</p>;
    case 'cancelling':
      return <p className="text-xs text-muted-foreground">{t('desktop.localModels.cancelling')}</p>;
    case 'error':
      return (
        <p className="text-xs text-destructive" data-testid="local-model-error">
          {t(`desktop.localModels.errors.${ERROR_KEYS[download.error ?? 'io']}`)}
        </p>
      );
  }
}

function ModelRow({
  model,
  active,
  locale,
  onUse,
  onDelete,
}: {
  model: LocalModel;
  active: boolean;
  locale: SupportedLocale;
  onUse: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const caps = useDesktopCapabilities();
  const download = model.download;

  const actions =
    download?.status === 'downloading' ? (
      <Button variant="outline" size="sm" onClick={() => void caps.localModels.cancelDownload(model.id)}>
        {t('desktop.localModels.cancel')}
      </Button>
    ) : download?.status === 'verifying' || download?.status === 'cancelling' ? (
      <Button variant="outline" size="sm" disabled>
        {t('desktop.localModels.cancel')}
      </Button>
    ) : download?.status === 'error' ? (
      <>
        <Button variant="ghost" size="sm" onClick={() => void caps.localModels.cancelDownload(model.id)}>
          {t('desktop.localModels.dismiss')}
        </Button>
        <Button size="sm" onClick={() => void caps.localModels.download(model.id)}>
          {t('desktop.localModels.retry')}
        </Button>
      </>
    ) : model.installed ? (
      <>
        {active ? null : (
          <Button variant="outline" size="sm" onClick={onUse}>
            {t('desktop.localModels.useModel')}
          </Button>
        )}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" className="text-destructive">
              {t('desktop.localModels.delete')}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('desktop.localModels.deleteConfirmTitle', { name: model.name })}
              </AlertDialogTitle>
              <AlertDialogDescription>{t('desktop.localModels.deleteConfirm')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('desktop.localModels.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={onDelete}
              >
                {t('desktop.localModels.delete')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    ) : (
      <Button size="sm" onClick={() => void caps.localModels.download(model.id)}>
        {t('desktop.localModels.download')}
      </Button>
    );

  return (
    <li
      className="flex items-center justify-between gap-4 py-3"
      data-testid="local-model-row"
      data-model-id={model.id}
      data-installed={model.installed}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{model.name}</span>
          {model.installed ? (
            <Badge variant="outline">{t('desktop.localModels.installed')}</Badge>
          ) : null}
          {active && model.installed ? (
            <Badge data-testid="local-model-active">{t('desktop.localModels.active')}</Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {formatApplicationBytes(model.sizeBytes, locale)}
        </p>
        {download ? <DownloadStatus download={download} locale={locale} /> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </li>
  );
}

export function LocalModelsScreen({ transcription, onPatch }: {
  transcription: TranscriptionSetting;
  onPatch: (fields: Partial<TranscriptionSetting>) => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const caps = useDesktopCapabilities();
  const localMode = useDesktopEnv().appMode === 'local';
  const state = useLocalModels();

  // Whisper weights only — the VAD entry is managed beside the first
  // whisper download, not chosen by the user.
  const models = state?.models.filter(model => model.kind === 'whisper') ?? [];
  // The EFFECTIVE active id mirrors main's resolution (modelId ?? DEFAULT_LOCAL_MODEL_ID).
  // The Active badge renders only when that model is actually INSTALLED (a
  // badge on missing weights would be a lie); the delete handler keys on the
  // same effective id.
  const preferredId = transcription.modelId ?? DEFAULT_LOCAL_MODEL_ID;
  const onDevice = transcription.engine === 'local' || (localMode && transcription.engine === 'cloud');
  const activeId = onDevice ? preferredId : null;

  // The page merges field patches with pending edits from the other model cards.
  const setActiveModel = (modelId: string | null): void => {
    onPatch({ engine: 'local', modelId });
  };
  const deleteModel = (model: LocalModel): void => {
    void caps.localModels.delete(model.id);
    // Never leave the EFFECTIVE choice pointing at deleted weights: this row
    // can be active through the explicit preference OR as the null-default
    // default fallback. Move the preference to another installed whisper
    // model when one exists, else back to null.
    if (model.id === preferredId) {
      const fallback =
        models.find(candidate => candidate.installed && candidate.id !== model.id)?.id ?? null;
      if (fallback !== transcription.modelId)
        onPatch({ modelId: fallback });
    }
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-xl font-bold">{t('desktop.localModels.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('desktop.localModels.description')}</p>
      </div>

      <Card>
        <CardContent>
          {state === null ? (
            <p className="text-sm text-muted-foreground">{t('desktop.localModels.loading')}</p>
          ) : (
            <>
              <p className="break-all text-xs text-muted-foreground" data-testid="local-models-dir">
                {t('desktop.localModels.storageLocation', { path: state.modelsDir })}
              </p>
              <ul className="mt-2 divide-y divide-border" data-testid="local-models-list">
                {models.map(model => (
                  <ModelRow
                    key={model.id}
                    model={model}
                    active={model.id === activeId}
                    locale={resolvedLocale}
                    onUse={() => setActiveModel(model.id)}
                    onDelete={() => deleteModel(model)}
                  />
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
