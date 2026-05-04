"use client";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { api } from "@/trpc/react";
import {
  PROVIDER_TYPE_CAPABILITIES,
  PROVIDER_TYPE_MULTI_INSTANCE,
  isProviderType,
  type ProviderType,
} from "@/constants/provider-types";
import { PROVIDER_META } from "@/renderer/main/components/provider-meta";
import type { Instance } from "@/db/schema";
import type { CatalogEntry, ModelType } from "@/services/catalog";

type UseCase = "transcription" | "formatting";

const USE_CASE_TO_MODEL_TYPE: Record<UseCase, ModelType> = {
  transcription: "transcription",
  formatting: "language",
};

interface ChangeDefaultDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  useCase: UseCase;
  /** Opens the Whisper Manage dialog when the user clicks an inline link
   *  next to a not-downloaded Whisper row. The parent owns that dialog
   *  so we don't end up with two managers fighting over the same state. */
  onOpenWhisperManager: () => void;
}

// Two-step picker for setting a model default.
//
// Step 1 — choose a connected instance, filtered by capability map.
//   Auto-skips when only one instance is eligible (the only-card click
//   would be busywork).
// Step 2 — pick a model from the chosen instance's catalog.
//   Catalog fetches lazily on entry to step 2 (one fetch, not N).
//   For Whisper, not-downloaded models are listed but disabled, with
//   an inline link to the file manager.
export default function ChangeDefaultDialog({
  open,
  onOpenChange,
  useCase,
  onOpenWhisperManager,
}: ChangeDefaultDialogProps) {
  const utils = api.useUtils();
  const modelType = USE_CASE_TO_MODEL_TYPE[useCase];

  const [chosenInstanceId, setChosenInstanceId] = useState<string | null>(null);
  const [pendingModelId, setPendingModelId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [stepOneSkipped, setStepOneSkipped] = useState(false);

  const instancesQuery = api.instances.list.useQuery(undefined, {
    enabled: open,
  });
  const defaultsQuery = api.instances.getDefaults.useQuery(undefined, {
    enabled: open,
  });
  const catalogQuery = api.instances.fetchCatalog.useQuery(
    { id: chosenInstanceId! },
    {
      enabled: open && !!chosenInstanceId,
      // Force a refetch on every step-2 mount. The picker is a rare,
      // intentional interaction; serving cached catalog from a
      // previous session here masks fixes/changes to the catalog
      // shape and surfaces stale model lists.
      refetchOnMount: "always",
    },
  );

  const setDefaultMutation = api.instances.setDefault.useMutation({
    onSuccess: () => {
      utils.instances.getDefaults.invalidate();
      // Whisper-local-only: SpeechTab's RadioGroup binds to
      // models.getSelectedModel which the local-whisper code path
      // updates separately. Keep them in sync.
      if (useCase === "transcription") {
        utils.models.getSelectedModel.invalidate();
      }
      toast.success(`Default ${useCase} model updated`);
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(`Couldn't set default: ${error.message}`);
    },
  });

  const refreshCatalogsMutation = api.instances.refreshCatalogs.useMutation({
    onSuccess: () => {
      utils.instances.fetchCatalog.invalidate();
    },
    onError: (error) => {
      toast.error(`Couldn't refresh catalogs: ${error.message}`);
    },
  });

  // Reset to step 1 each time the dialog opens. Without this, the
  // dialog would stay parked on whichever step the user was on last
  // time — confusing if their instance list changed.
  useEffect(() => {
    if (open) {
      setChosenInstanceId(null);
      setPendingModelId(null);
      setSearchQuery("");
      setStepOneSkipped(false);
    }
  }, [open]);

  // Auto-skip step 1 when only one instance is eligible. Runs once
  // per open, gated by `stepOneSkipped` so back-button works.
  const eligibleInstances = useMemo<Instance[]>(() => {
    if (!instancesQuery.data) return [];
    return instancesQuery.data.filter((i) => {
      if (!isProviderType(i.provider)) return false;
      return PROVIDER_TYPE_CAPABILITIES[i.provider as ProviderType].includes(
        modelType,
      );
    });
  }, [instancesQuery.data, modelType]);

  useEffect(() => {
    if (!open || stepOneSkipped) return;
    if (chosenInstanceId) return;
    if (eligibleInstances.length === 1) {
      setChosenInstanceId(eligibleInstances[0].id);
      setStepOneSkipped(true);
    }
  }, [open, stepOneSkipped, chosenInstanceId, eligibleInstances]);

  // Pre-select the current model when entering step 2 so saving
  // without changing anything is a no-op (or at least an obvious
  // no-op the user can confirm).
  useEffect(() => {
    if (!chosenInstanceId) return;
    const currentSelection = defaultsQuery.data?.[useCase];
    if (currentSelection?.instanceId === chosenInstanceId) {
      setPendingModelId(currentSelection.modelId);
    } else {
      setPendingModelId(null);
    }
  }, [chosenInstanceId, defaultsQuery.data, useCase]);

  const chosenInstance = chosenInstanceId
    ? instancesQuery.data?.find((i) => i.id === chosenInstanceId)
    : undefined;

  const isWhisperInstance = chosenInstance?.provider === "local-whisper";

  // Whisper rows whose model file isn't downloaded should be visible
  // but unselectable. We compute this lookup from the same data the
  // Whisper manager uses so the two views never disagree.
  const downloadedModelsQuery = api.models.getDownloadedModels.useQuery(
    undefined,
    { enabled: open && isWhisperInstance },
  );

  const filteredCatalog = useMemo<CatalogEntry[]>(() => {
    const all = catalogQuery.data ?? [];
    let matching = all.filter((entry) => entry.type === modelType);
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      matching = matching.filter(
        (entry) =>
          entry.id.toLowerCase().includes(q) ||
          entry.name.toLowerCase().includes(q),
      );
    }
    // Sort: newest releaseDate first; entries without a date stay in
    // the order the fetcher returned them (the fetcher is the right
    // place to encode provider-specific ordering — e.g., Whisper
    // returns largest-model-first since size = quality there).
    // sort() is stable so equal-rank entries keep input order.
    return matching.slice().sort((a, b) => {
      if (a.releaseDate && b.releaseDate) {
        return b.releaseDate.localeCompare(a.releaseDate);
      }
      if (a.releaseDate) return -1;
      if (b.releaseDate) return 1;
      return 0;
    });
  }, [catalogQuery.data, modelType, searchQuery]);

  const handleBackToStepOne = () => {
    setChosenInstanceId(null);
    setPendingModelId(null);
    setSearchQuery("");
    // Keep `stepOneSkipped` true: if there was only one eligible
    // instance, going "back" would just auto-skip again. Better to
    // let the user see the (single) card and click it explicitly so
    // the back button isn't a UI dead end.
  };

  const handleSave = () => {
    if (!chosenInstanceId || !pendingModelId) return;
    setDefaultMutation.mutate({
      useCase,
      selection: { instanceId: chosenInstanceId, modelId: pendingModelId },
    });
  };

  const useCaseTitle = useCase === "transcription" ? "transcription" : "formatting";

  // Step 1 view
  if (!chosenInstanceId) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Change {useCaseTitle} model</DialogTitle>
            <DialogDescription>
              Step 1 of 2 — choose a provider.
            </DialogDescription>
          </DialogHeader>

          {instancesQuery.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : eligibleInstances.length === 0 ? (
            <div className="rounded-md border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
              No connected providers can serve {useCaseTitle} yet. Add one
              from the providers list on the AI Models page.
            </div>
          ) : (
            // Same divided-list shape as ConnectedList on the settings
            // page — strip credential previews and per-row actions
            // (each row is the action: click to advance to step 2).
            // Capped height with internal scroll for users with many
            // configured instances.
            <div className="rounded-md border divide-y bg-card max-h-[400px] overflow-y-auto">
              {eligibleInstances.map((instance) => {
                if (!isProviderType(instance.provider)) return null;
                const meta = PROVIDER_META[instance.provider];
                const isCurrent =
                  defaultsQuery.data?.[useCase]?.instanceId === instance.id;
                const showInstanceLabel =
                  PROVIDER_TYPE_MULTI_INSTANCE[instance.provider];
                return (
                  <button
                    key={instance.id}
                    type="button"
                    onClick={() => setChosenInstanceId(instance.id)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40 text-left transition-colors"
                  >
                    <meta.Logo
                      className={`size-4 shrink-0 ${meta.tint ?? ""}`}
                    />
                    <span className="text-sm font-medium truncate flex-1 min-w-0">
                      {meta.label}
                      {showInstanceLabel && (
                        <span className="text-muted-foreground">
                          {" · "}
                          {instance.label}
                        </span>
                      )}
                    </span>
                    {isCurrent && (
                      <Badge
                        variant="secondary"
                        className="text-xs shrink-0"
                      >
                        Current
                      </Badge>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleBackToStepOne}
              className="h-7 gap-1 px-2"
            >
              <ArrowLeft className="size-3.5" />
              Back
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
            Step 2 of 2 — pick a {useCaseTitle} model.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search models…"
              className="pl-8 h-9"
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => refreshCatalogsMutation.mutate()}
            disabled={refreshCatalogsMutation.isPending}
            className="h-9 gap-1 text-xs"
          >
            <RefreshCw
              className={`size-3.5 ${refreshCatalogsMutation.isPending ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>

        {/* Plain bordered scroll container — Card ships with py-6
            baked in which would stack on top of inner padding and
            create a dead band above/below the list. */}
        <div className="rounded-md border bg-card max-h-[400px] overflow-auto">
          {catalogQuery.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : catalogQuery.error ? (
            <div className="p-4 text-sm text-destructive">
              Couldn't load catalog: {catalogQuery.error.message}
            </div>
          ) : filteredCatalog.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground italic">
              {searchQuery
                ? `No models match "${searchQuery}".`
                : `This provider has no ${useCaseTitle} models available.`}
            </div>
          ) : (
            <RadioGroup
              value={pendingModelId ?? ""}
              onValueChange={setPendingModelId}
              className="p-1.5 gap-0"
            >
              {filteredCatalog.map((entry) => (
                <CatalogRow
                  key={entry.id}
                  entry={entry}
                  isWhisper={isWhisperInstance}
                  isDownloaded={
                    isWhisperInstance
                      ? !!downloadedModelsQuery.data?.[entry.id]
                      : true
                  }
                  onOpenWhisperManager={onOpenWhisperManager}
                />
              ))}
            </RadioGroup>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              !pendingModelId ||
              setDefaultMutation.isPending ||
              (isWhisperInstance &&
                !downloadedModelsQuery.data?.[pendingModelId])
            }
          >
            {setDefaultMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface CatalogRowProps {
  entry: CatalogEntry;
  isWhisper: boolean;
  isDownloaded: boolean;
  onOpenWhisperManager: () => void;
}

function CatalogRow({
  entry,
  isWhisper,
  isDownloaded,
  onOpenWhisperManager,
}: CatalogRowProps) {
  const disabled = isWhisper && !isDownloaded;
  // Show the raw id as a smaller secondary line only when it differs
  // from the friendly name AND we're not on a Whisper row (the
  // curated Whisper names are self-explanatory; the id underneath is
  // noise).
  const showId = !isWhisper && entry.id !== entry.name;
  return (
    <div
      className={`flex items-center gap-3 rounded-md p-2 ${disabled ? "opacity-60" : "hover:bg-accent"}`}
    >
      <RadioGroupItem value={entry.id} id={entry.id} disabled={disabled} />
      <Label
        htmlFor={entry.id}
        // shadcn Label has `items-center` baked in — explicitly override
        // to items-start so name/id/description stack left-aligned.
        className={`flex-1 min-w-0 flex flex-col gap-0.5 items-start ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      >
        <span className="text-sm font-medium truncate">{entry.name}</span>
        {showId && (
          <span className="text-xs text-muted-foreground truncate font-mono">
            {entry.id}
          </span>
        )}
        {entry.description && (
          <span className="text-xs text-muted-foreground line-clamp-1">
            {entry.description}
          </span>
        )}
      </Label>
      {isWhisper && !isDownloaded && (
        <Button
          size="sm"
          variant="ghost"
          onClick={(e) => {
            e.preventDefault();
            onOpenWhisperManager();
          }}
          className="h-6 px-2 text-xs"
        >
          Manage
        </Button>
      )}
    </div>
  );
}
