'use client';

import { Loader2, RefreshCw, Search } from 'lucide-react';

import { Button } from '../../../../ui/button';
import { Input } from '../../../../ui/input';
import { Label } from '../../../../ui/label';
import { RadioGroup, RadioGroupItem } from '../../../../ui/radio-group';
import { useInstanceModels } from '@prismical/app-client';
import type { ModelType } from '../../../../lib/providers';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Single-select model picker over an instance's LIVE catalog, filtered to one capability.
 * Reused by the add-provider wizard's Skills/Transcription steps and the edit
 * dialog's default rows. Auto sits OUTSIDE this — it's offered as a separate choice by the caller.
 */
export function SingleModelPicker({
  instanceId,
  modelType,
  value,
  onChange,
  enabled,
  useCaseLabel,
}: {
  instanceId: string;
  modelType: ModelType;
  value: string | null;
  onChange: (modelId: string) => void;
  enabled: boolean;
  /** e.g. "transcription" / "text generation" — used in the empty-state copy. */
  useCaseLabel: string;
}) {
  const { t, i18n } = useTranslation();
  const {
    data: catalog = [],
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useInstanceModels(instanceId, enabled);
  const [search, setSearch] = useState('');

  const models = useMemo(() => {
    let list = catalog.filter(m => m.type === modelType);
    const q = search.trim().toLowerCase();
    if (q)
      list = list.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    return list.slice().sort((a, b) => {
      if (a.releaseDate && b.releaseDate) return b.releaseDate.localeCompare(a.releaseDate);
      if (a.releaseDate) return -1;
      if (b.releaseDate) return 1;
      return 0;
    });
  }, [catalog, modelType, search]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('settings.aiModels.modelPicker.search')}
            className="pl-8 h-9"
          />
        </div>
        <Button size="sm" variant="ghost" onClick={() => refetch()} className="h-9 gap-1 text-xs">
          <RefreshCw className={`size-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          {t('settings.aiModels.modelPicker.refresh')}
        </Button>
      </div>

      <div className="rounded-md border bg-card max-h-56 overflow-auto">
        {isLoading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('settings.aiModels.modelPicker.loading')}
          </div>
        ) : isError ? (
          <div className="flex items-center justify-between gap-2 p-3 text-xs text-destructive">
            <span>{t('settings.aiModels.modelCuration.loadError')}</span>
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              {t('settings.aiModels.modelPicker.retry')}
            </Button>
          </div>
        ) : models.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground italic">
            {search
              ? t('settings.aiModels.modelPicker.noMatch', { query: search })
              : t('settings.aiModels.modelPicker.noModels', { useCase: useCaseLabel })}
          </div>
        ) : (
          <RadioGroup value={value ?? ''} onValueChange={onChange} className="p-1.5 gap-0">
            {models.map(m => (
              <label
                key={m.id}
                className="flex cursor-pointer items-center gap-3 rounded-md p-2 hover:bg-accent"
              >
                <RadioGroupItem value={m.id} id={`smp-${m.id}`} />
                <Label
                  htmlFor={`smp-${m.id}`}
                  className="flex-1 min-w-0 cursor-pointer truncate text-sm"
                >
                  {m.name}
                </Label>
                {typeof m.context === 'number' && (
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {new Intl.NumberFormat(i18n.resolvedLanguage, {
                      notation: 'compact',
                    }).format(m.context)}
                  </span>
                )}
              </label>
            ))}
          </RadioGroup>
        )}
      </div>
    </div>
  );
}
