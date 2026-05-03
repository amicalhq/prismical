"use client";
import { useMemo } from "react";
import { Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/trpc/react";
import { toast } from "sonner";
import {
  selectionToKey,
  keyToSelection,
} from "@/utils/model-selection";
import { isProviderType } from "@/constants/provider-types";
import { PROVIDER_META } from "@/renderer/main/components/provider-meta";
import { invalidateModelsDevCache } from "@/services/catalog";
import type { Instance } from "@/db/schema";
import type { CatalogEntry, ModelType } from "@/services/catalog";

type UseCase = "transcription" | "formatting" | "embedding";

const USE_CASE_TO_MODEL_TYPE: Record<UseCase, ModelType> = {
  transcription: "speech",
  formatting: "language",
  embedding: "embedding",
};

interface DefaultModelPickerProps {
  useCase: UseCase;
  title: string;
}

export default function DefaultModelPicker({
  useCase,
  title,
}: DefaultModelPickerProps) {
  const utils = api.useUtils();
  const modelType = USE_CASE_TO_MODEL_TYPE[useCase];

  const instancesQuery = api.instances.list.useQuery();
  const defaultsQuery = api.instances.getDefaults.useQuery();

  const invalidateAfterTranscriptionChange = () => {
    // SpeechTab's Whisper RadioGroup binds to `models.getSelectedModel`,
    // which only the local-whisper code path knows to refetch. Invalidate
    // it explicitly so the table radio stays in sync when the picker
    // changes the transcription default to/from a non-local provider.
    utils.models.getSelectedModel.invalidate();
  };

  const setDefaultMutation = api.instances.setDefault.useMutation({
    onSuccess: () => {
      utils.instances.getDefaults.invalidate();
      if (useCase === "transcription") invalidateAfterTranscriptionChange();
      toast.success(`Default ${title.toLowerCase()} model updated`);
    },
    onError: (error) => {
      toast.error(`Couldn't set default: ${error.message}`);
    },
  });

  const clearDefaultMutation = api.instances.clearDefault.useMutation({
    onSuccess: () => {
      utils.instances.getDefaults.invalidate();
      if (useCase === "transcription") invalidateAfterTranscriptionChange();
    },
    onError: (error) => {
      toast.error(`Couldn't clear default: ${error.message}`);
    },
  });

  // Listen for selection changes from ModelService (whisper auto-select etc.)
  api.models.onSelectionChanged.useSubscription(undefined, {
    onData: () => {
      utils.instances.getDefaults.invalidate();
    },
  });

  const instances = instancesQuery.data ?? [];
  const currentSelection = defaultsQuery.data?.[useCase];
  const currentValue = currentSelection ? selectionToKey(currentSelection) : "";

  const isLoading = instancesQuery.isLoading || defaultsQuery.isLoading;

  const handleChange = (value: string) => {
    if (!value || value === currentValue) return;
    const sel = keyToSelection(value);
    if (!sel) return;
    setDefaultMutation.mutate({ useCase, selection: sel });
  };

  const handleClear = () => {
    clearDefaultMutation.mutate({ useCase });
  };

  const handleRefreshAll = () => {
    invalidateModelsDevCache();
    utils.instances.fetchCatalog.invalidate();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-base font-semibold">{title}</Label>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 text-xs text-muted-foreground"
          onClick={handleRefreshAll}
          aria-label="Refresh catalogs"
        >
          <RefreshCw className="size-3.5" />
          Refresh
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Select
          value={currentValue}
          onValueChange={handleChange}
          disabled={isLoading}
        >
          <SelectTrigger className="max-w-md">
            <SelectValue
              placeholder={
                isLoading ? "Loading…" : "Choose a model"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {instances.length === 0 ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">
                Connect a provider above to pick a model.
              </div>
            ) : (
              instances.map((instance) => (
                <InstanceOptionGroup
                  key={instance.id}
                  instance={instance}
                  modelType={modelType}
                />
              ))
            )}
          </SelectContent>
        </Select>

        {currentValue && (
          <Button
            size="icon"
            variant="ghost"
            className="size-9"
            onClick={handleClear}
            aria-label="Clear default"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

interface InstanceOptionGroupProps {
  instance: Instance;
  modelType: ModelType;
}

/**
 * One <SelectGroup> per instance. Catalog fetch is mounted per-instance so
 * a slow provider doesn't block the others; React Query caches across
 * remounts within the session.
 */
function InstanceOptionGroup({
  instance,
  modelType,
}: InstanceOptionGroupProps) {
  const catalogQuery = api.instances.fetchCatalog.useQuery(
    { id: instance.id },
    {
      retry: false,
      // Catalogs change infrequently; trust React Query's session cache.
      staleTime: 5 * 60_000,
    },
  );

  const meta = isProviderType(instance.type)
    ? PROVIDER_META[instance.type]
    : null;

  const filtered = useMemo<CatalogEntry[]>(() => {
    if (!catalogQuery.data) return [];
    return catalogQuery.data.filter((m) => m.type === modelType);
  }, [catalogQuery.data, modelType]);

  if (catalogQuery.isLoading) {
    return (
      <SelectGroup>
        <SelectLabel className="flex items-center gap-2">
          {meta && <meta.Logo className={`size-3.5 ${meta.tint ?? ""}`} />}
          {instance.label}
        </SelectLabel>
        <div className="px-2 py-1 text-xs text-muted-foreground flex items-center gap-2">
          <Loader2 className="size-3 animate-spin" />
          Loading…
        </div>
      </SelectGroup>
    );
  }

  if (catalogQuery.isError) {
    return (
      <SelectGroup>
        <SelectLabel className="flex items-center gap-2">
          {meta && <meta.Logo className={`size-3.5 ${meta.tint ?? ""}`} />}
          {instance.label}
        </SelectLabel>
        <div className="px-2 py-1 text-xs text-destructive">
          {catalogQuery.error?.message ?? "Failed to load"}
        </div>
      </SelectGroup>
    );
  }

  if (filtered.length === 0) {
    return null; // hide empty groups so the dropdown isn't full of headers with nothing under them
  }

  return (
    <SelectGroup>
      <SelectLabel className="flex items-center gap-2">
        {meta && <meta.Logo className={`size-3.5 ${meta.tint ?? ""}`} />}
        {instance.label}
      </SelectLabel>
      {filtered.map((entry) => (
        <SelectItem
          key={entry.id}
          value={selectionToKey({ instanceId: instance.id, modelId: entry.id })}
        >
          {entry.name}
        </SelectItem>
      ))}
    </SelectGroup>
  );
}
