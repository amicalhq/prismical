'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Loader2, RefreshCw, Search, Sparkles } from 'lucide-react';

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
import { Label } from '../../../../ui/label';
import { Badge } from '../../../../ui/badge';
import { RadioGroup, RadioGroupItem } from '../../../../ui/radio-group';
import type { CatalogEntry, Instance, UseCase } from '../../mock-data';
import {
  CLOUD_CATALOG_PROVIDERS,
  isProviderType,
  PROVIDER_META,
  PROVIDER_TYPE_CAPABILITIES,
  PROVIDER_TYPE_MULTI_INSTANCE,

  type ModelType,
  type ProviderType,
} from '../../../../lib/providers';
import { TranscriptionCaveats } from './transcription-caveats';
import { useInstanceModels } from '@prismical/app-client';
import { AUTO_SELECTION, PRISMICAL_CLOUD_INSTANCE_ID } from '@prismical/app-client';

import { useAIModels } from './ai-models-store';
import { useTranslation } from 'react-i18next';

const USE_CASE_TO_MODEL_TYPE: Record<UseCase, ModelType> = {
  transcription: 'transcription',
  formatting: 'language',
};

interface ChangeDefaultDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  useCase: UseCase;
}

// Two-step picker for setting a model default.
//   Step 1 — choose a connected instance, filtered by capability map.
//     Auto-skips when only one instance is eligible.
//   Step 2 — pick a model from the chosen instance's catalog (searchable).
export default function ChangeDefaultDialog({ open, onOpenChange, useCase }: ChangeDefaultDialogProps) {
  const { t } = useTranslation();
  const { instances, defaults, getInstance, setDefault } = useAIModels();
  const modelType = USE_CASE_TO_MODEL_TYPE[useCase];

  const [chosenInstanceId, setChosenInstanceId] = useState<string | null>(null);
  const [pendingModelId, setPendingModelId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Reset to step 1 each time the dialog opens.
  useEffect(() => {
    if (open) {
      setChosenInstanceId(null);
      setPendingModelId(null);
      setSearchQuery('');
      setIsRefreshing(false);
    }
  }, [open]);

  // Instances eligible for this use case: a cloud-served provider (has a fetchable catalog) AND one
  // that supports this capability. Excludes connected-but-unsupported types (Ollama, Anthropic, …)
  // so the picker never dead-ends at a catalog fetch the cloud can't satisfy.
  const eligibleInstances = useMemo<Instance[]>(() => {
    return instances.filter(i => {
      if (!isProviderType(i.provider)) return false;
      const p = i.provider as ProviderType;
      return (
        CLOUD_CATALOG_PROVIDERS.includes(p) && PROVIDER_TYPE_CAPABILITIES[p].includes(modelType)
      );
    });
  }, [instances, modelType]);

  // Pre-select the current model when entering step 2.
  useEffect(() => {
    if (!chosenInstanceId) return;
    const currentSelection = defaults[useCase];
    if (currentSelection?.instanceId === chosenInstanceId) {
      setPendingModelId(currentSelection.modelId);
    } else {
      setPendingModelId(null);
    }
  }, [chosenInstanceId, defaults, useCase]);

  const chosenInstance = chosenInstanceId ? getInstance(chosenInstanceId) : undefined;

  // Cloud providers: fetch the LIVE catalog from the provider (GET /me/instances/:id/models).
  // Only runs on step 2. (Every eligible instance is a CLOUD_CATALOG_PROVIDERS member.)
  const liveModels = useInstanceModels(
    chosenInstanceId ?? undefined,
    open && Boolean(chosenInstanceId)
  );

  const filteredCatalog = useMemo<CatalogEntry[]>(() => {
    const all = liveModels.data ?? [];
    let matching = all.filter(entry => entry.type === modelType);
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      matching = matching.filter(
        entry => entry.id.toLowerCase().includes(q) || entry.name.toLowerCase().includes(q)
      );
    }
    // Sort: newest releaseDate first; dateless entries keep input order.
    return matching.slice().sort((a, b) => {
      if (a.releaseDate && b.releaseDate) {
        return b.releaseDate.localeCompare(a.releaseDate);
      }
      if (a.releaseDate) return -1;
      if (b.releaseDate) return 1;
      return 0;
    });
  }, [liveModels.data, modelType, searchQuery]);

  const handleBackToStepOne = () => {
    setChosenInstanceId(null);
    setPendingModelId(null);
    setSearchQuery('');
  };

  const handleRefresh = () => {
    void liveModels.refetch();
  };

  // Pick managed Auto (Prismical Cloud) directly from step 1 — no model to choose.
  const handleSelectAuto = () => {
    setDefault(useCase, AUTO_SELECTION);
    onOpenChange(false);
  };

  const handleSave = () => {
    if (!chosenInstanceId || !pendingModelId) return;
    setDefault(useCase, {
      instanceId: chosenInstanceId,
      modelId: pendingModelId,
    });
    onOpenChange(false);
  };

  const useCaseTitle = t(
    useCase === 'transcription'
      ? 'settings.aiModels.useCases.transcription.label'
      : 'settings.aiModels.useCases.formatting.label'
  );

  // Step 1 view
  if (!chosenInstanceId) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t('settings.aiModels.change.title', { useCase: useCaseTitle })}
            </DialogTitle>
            <DialogDescription>{t('settings.aiModels.change.stepSource')}</DialogDescription>
          </DialogHeader>

          <div className="rounded-md border divide-y bg-card max-h-[400px] overflow-y-auto">
            {/* Managed Auto is always available — no key, no model to pick. */}
            <button
              type="button"
              onClick={handleSelectAuto}
              className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-accent text-left transition-colors"
            >
              <Sparkles className="size-4 shrink-0 text-muted-foreground" />
              <span className="text-sm font-medium truncate flex-1 min-w-0">
                {t('settings.aiModels.managedAuto')}
              </span>
              {defaults[useCase]?.instanceId === PRISMICAL_CLOUD_INSTANCE_ID && (
                <Badge variant="secondary" className="text-xs shrink-0">
                  {t('settings.aiModels.current')}
                </Badge>
              )}
            </button>

            {eligibleInstances.length === 0 ? (
              <div className="px-3 py-3 text-center text-xs text-muted-foreground">
                {t('settings.aiModels.change.connectProvider', { useCase: useCaseTitle })}
              </div>
            ) : (
              eligibleInstances.map(instance => {
                if (!isProviderType(instance.provider)) return null;
                const meta = PROVIDER_META[instance.provider];
                const isCurrent = defaults[useCase]?.instanceId === instance.id;
                const showInstanceLabel = PROVIDER_TYPE_MULTI_INSTANCE[instance.provider];
                return (
                  <button
                    key={instance.id}
                    type="button"
                    onClick={() => setChosenInstanceId(instance.id)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-accent text-left transition-colors"
                  >
                    <meta.Logo className={`size-4 shrink-0 ${meta.tint ?? ''}`} />
                    <span className="text-sm font-medium truncate flex-1 min-w-0">
                      {meta.label}
                      {showInstanceLabel && (
                        <span className="text-muted-foreground">
                          {' · '}
                          {instance.label}
                        </span>
                      )}
                    </span>
                    {isCurrent && (
                      <Badge variant="secondary" className="text-xs shrink-0">
                        {t('settings.aiModels.current')}
                      </Badge>
                    )}
                  </button>
                );
              })
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Step 2 view
  const chosenMeta =
    chosenInstance && isProviderType(chosenInstance.provider)
      ? PROVIDER_META[chosenInstance.provider]
      : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleBackToStepOne}
              className="h-7 gap-1 px-2"
            >
              <ArrowLeft className="size-3.5" />
              {t('common.actions.back')}
            </Button>
            <span className="text-xs text-muted-foreground">·</span>
            <DialogTitle className="text-base">
              {chosenMeta && chosenInstance && (
                <span className="inline-flex items-center gap-2">
                  <chosenMeta.Logo className="size-4" />
                  {chosenMeta.label} · {chosenInstance.label}
                </span>
              )}
            </DialogTitle>
          </div>
          <DialogDescription>
            {t('settings.aiModels.change.stepModel', { useCase: useCaseTitle })}
          </DialogDescription>
        </DialogHeader>

        {/* Same component the wizard and edit dialog use. These caveats are properties of the
            provider's transcription lane, not of BYOK - the managed lane labels speakers and some
            BYOK providers will too - so they are keyed off the capability maps rather than "is this
            a user's own key". */}
        {useCase === 'transcription' && chosenMeta && (
          <TranscriptionCaveats
            provider={chosenInstance?.provider}
            providerLabel={chosenMeta.label}
          />
        )}

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={t('settings.aiModels.modelPicker.search')}
              className="pl-8 h-9"
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="h-9 gap-1 text-xs"
          >
            <RefreshCw className={`size-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            {t('settings.aiModels.modelPicker.refresh')}
          </Button>
        </div>

        <div className="rounded-md border bg-card max-h-[400px] overflow-auto">
          {liveModels.isLoading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('settings.aiModels.modelPicker.loading')}
            </div>
          ) : liveModels.isError ? (
            <div className="p-4 text-sm text-destructive">
              {t('settings.aiModels.change.loadError')}
            </div>
          ) : filteredCatalog.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground italic">
              {searchQuery
                ? t('settings.aiModels.change.noMatch', { query: searchQuery })
                : t('settings.aiModels.change.noModels', { useCase: useCaseTitle })}
            </div>
          ) : (
            <RadioGroup
              value={pendingModelId ?? ''}
              onValueChange={setPendingModelId}
              className="p-1.5 gap-0"
            >
              {filteredCatalog.map(entry => (
                <CatalogRow key={entry.id} entry={entry} />
              ))}
            </RadioGroup>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.actions.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={!pendingModelId}>
            {t('common.actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface CatalogRowProps {
  entry: CatalogEntry;
}

function CatalogRow({ entry }: CatalogRowProps) {
  // Show the raw id as a secondary line only when it differs from the name.
  const showId = entry.id !== entry.name;
  return (
    <div className="flex items-center gap-3 rounded-md p-2 hover:bg-accent">
      <RadioGroupItem value={entry.id} id={entry.id} />
      <Label
        htmlFor={entry.id}
        className="flex-1 min-w-0 flex flex-col gap-0.5 items-start cursor-pointer"
      >
        <span className="text-sm font-medium truncate">{entry.name}</span>
        {showId && (
          <span className="text-xs text-muted-foreground truncate font-mono">{entry.id}</span>
        )}
        {entry.description && (
          <span className="text-xs text-muted-foreground line-clamp-1">{entry.description}</span>
        )}
      </Label>
    </div>
  );
}
