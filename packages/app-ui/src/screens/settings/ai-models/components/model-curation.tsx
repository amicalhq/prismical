'use client';

import { Loader2, RefreshCw } from 'lucide-react';

import { Button } from '../../../../ui/button';
import { Checkbox } from '../../../../ui/checkbox';
import { Label } from '../../../../ui/label';
import { useInstanceModels } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

/**
 * The per-instance model-curation picker. Fetches the instance's live catalog
 * (GET /me/instances/:id/models) and lets the user check which **language** models appear in the Ask
 * AI model selector. The checked ids are persisted to `instance.config.selectedModels` by the parent
 * dialog. Only mounted for an existing instance whose provider has a cloud catalog, since the fetch
 * needs the stored credential.
 */
export function ModelCuration({
  instanceId,
  value,
  onChange,
  enabled,
}: {
  instanceId: string;
  value: string[];
  onChange: (next: string[]) => void;
  enabled: boolean;
}) {
  const { t, i18n } = useTranslation();
  const {
    data: catalog = [],
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useInstanceModels(instanceId, enabled);
  const models = catalog.filter(m => m.type === 'language');
  const offered = new Set(models.map(m => m.id));
  /**
   * Ids that were curated before the catalog stopped offering them. They stay CHECKED and visible:
   * rendering only what the catalog returns would show "(2 selected)" above zero checkboxes, with
   * no way to uncheck either one. Saving keeps them, so nothing is silently dropped — they simply
   * become removable.
   */
  const retained = value.filter(id => !offered.has(id));
  const selected = new Set(value);

  const toggle = (id: string, checked: boolean) => {
    const next = new Set(value);
    if (checked) next.add(id);
    else next.delete(id);
    onChange([...next]);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>
          {t('settings.aiModels.modelCuration.title')}
          {value.length > 0
            ? ` (${t('settings.aiModels.form.selected', { count: value.length })})`
            : ''}
        </Label>
        {!isLoading && (
          <button
            type="button"
            onClick={() => refetch()}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <RefreshCw className={`size-3 ${isFetching ? 'animate-spin' : ''}`} />
            {t('settings.aiModels.modelPicker.refresh')}
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {t('settings.aiModels.modelCuration.description')}
      </p>

      {isLoading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('settings.aiModels.modelPicker.loading')}
        </div>
      ) : isError ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span>{t('settings.aiModels.modelCuration.loadError')}</span>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            {t('settings.aiModels.modelPicker.retry')}
          </Button>
        </div>
      ) : models.length === 0 && retained.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">
          {t('settings.aiModels.modelCuration.empty')}
        </p>
      ) : (
        <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border p-2">
          {models.map(m => (
            <label
              key={m.id}
              className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-accent"
            >
              <Checkbox
                checked={selected.has(m.id)}
                onCheckedChange={c => toggle(m.id, c === true)}
              />
              <span className="truncate text-sm">{m.name}</span>
              {typeof m.context === 'number' && (
                <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
                  {new Intl.NumberFormat(i18n.resolvedLanguage, {
                    notation: 'compact',
                  }).format(m.context)}
                </span>
              )}
            </label>
          ))}
          {retained.map(id => (
            <label
              key={id}
              className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-accent"
            >
              <Checkbox checked onCheckedChange={c => toggle(id, c === true)} />
              <span className="truncate text-sm">{id}</span>
              <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
                {t('settings.aiModels.modelCuration.retired')}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
