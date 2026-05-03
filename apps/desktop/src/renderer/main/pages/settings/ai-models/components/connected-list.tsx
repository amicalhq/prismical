"use client";
import { useState } from "react";
import { Pencil, Trash2, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api } from "@/trpc/react";
import { toast } from "sonner";
import {
  isProviderType,
  PROVIDER_TYPES,
  SINGLETON_INSTANCE_IDS,
  type ProviderType,
} from "@/constants/provider-types";
import { PROVIDER_META } from "@/renderer/main/components/provider-meta";
import type { Instance, InstanceConfig } from "@/db/schema";

interface ConnectedListProps {
  /** Open the Edit form dialog for this instance id (cloud only). */
  onEdit: (id: string) => void;
  /** Open the Whisper download manager. */
  onOpenWhisperManager: () => void;
}

const SINGLETON_TYPES = new Set<ProviderType>(
  Object.keys(SINGLETON_INSTANCE_IDS) as ProviderType[],
);

// Display rank for connected rows. Local Whisper leads, cloud sits in
// the middle, Mock pinned to the very end (dev only).
function connectedRank(type: string): number {
  if (type === PROVIDER_TYPES.localWhisper) return 0;
  if (type === PROVIDER_TYPES.mock) return 99;
  return 50;
}

// Redacted preview of an instance's credential. Just enough so the
// user can recognize the configured value without exposing the
// secret.
function configPreview(type: ProviderType, config: InstanceConfig): string {
  switch (type) {
    case PROVIDER_TYPES.openai:
    case PROVIDER_TYPES.anthropic:
    case PROVIDER_TYPES.groq:
    case PROVIDER_TYPES.openRouter: {
      const apiKey = "apiKey" in config ? config.apiKey : "";
      return apiKey ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : "—";
    }
    case PROVIDER_TYPES.ollama: {
      return "url" in config ? config.url : "—";
    }
    case PROVIDER_TYPES.openAICompatible: {
      return "baseURL" in config ? config.baseURL : "—";
    }
    case PROVIDER_TYPES.localWhisper: {
      const downloaded =
        "downloadedModels" in config ? config.downloadedModels : [];
      const count = downloaded?.length ?? 0;
      return count === 1 ? "1 model downloaded" : `${count} models downloaded`;
    }
    case PROVIDER_TYPES.mock:
      return "dev only";
    default:
      return "";
  }
}

// Discriminated remove target so the AlertDialog can show the right
// copy and handler for each shape: removing a cloud instance row vs
// purging all downloaded Whisper models.
type RemoveTarget =
  | { kind: "cloud"; instance: Instance }
  | { kind: "whisper-all"; instance: Instance };

export default function ConnectedList({
  onEdit,
  onOpenWhisperManager,
}: ConnectedListProps) {
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const utils = api.useUtils();

  const instancesQuery = api.instances.list.useQuery();

  const removeMutation = api.instances.remove.useMutation({
    onSuccess: () => {
      toast.success("Instance removed");
      utils.instances.list.invalidate();
      utils.instances.listByType.invalidate();
      utils.instances.getDefaults.invalidate();
      setRemoveTarget(null);
    },
    onError: (error) => {
      toast.error(`Couldn't remove instance: ${error.message}`);
      setRemoveTarget(null);
    },
  });

  const deleteWhisperModelMutation = api.models.deleteModel.useMutation({
    onError: (error) => {
      toast.error(`Couldn't delete model: ${error.message}`);
    },
  });

  const isDev = process.env.NODE_ENV !== "production";

  // Single ordered list — no cloud-vs-system bifurcation. Hide
  // singletons that have nothing to manage:
  //   - local-whisper without downloads → only in Available tiles
  //   - mock outside dev → never shown
  const visible = (instancesQuery.data ?? [])
    .filter((i) => {
      if (!isProviderType(i.type)) return false;
      if (i.type === PROVIDER_TYPES.localWhisper) {
        const config = i.config;
        const count =
          "downloadedModels" in config
            ? (config.downloadedModels?.length ?? 0)
            : 0;
        return count > 0;
      }
      if (i.type === PROVIDER_TYPES.mock) return isDev;
      return true;
    })
    .sort((a, b) => connectedRank(a.type) - connectedRank(b.type));

  if (instancesQuery.isLoading) {
    return null;
  }

  if (visible.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground italic">
        No providers connected yet. Add one from the list below.
      </div>
    );
  }

  const handleConfirmRemove = async () => {
    if (!removeTarget) return;
    if (removeTarget.kind === "cloud") {
      removeMutation.mutate({ id: removeTarget.instance.id });
      return;
    }
    // whisper-all: purge every downloaded .bin sequentially. The
    // onModelDeleted subscription in WhisperManageDialog refreshes
    // state; here we close the dialog and surface a single success
    // toast at the end.
    const config = removeTarget.instance.config;
    const downloaded =
      "downloadedModels" in config ? (config.downloadedModels ?? []) : [];
    try {
      for (const model of downloaded) {
        await deleteWhisperModelMutation.mutateAsync({ modelId: model.id });
      }
      toast.success(
        `Removed ${downloaded.length} downloaded Whisper model${downloaded.length === 1 ? "" : "s"}`,
      );
      utils.instances.list.invalidate();
      utils.instances.fetchCatalog.invalidate();
      utils.instances.getDefaults.invalidate();
    } finally {
      setRemoveTarget(null);
    }
  };

  return (
    <>
      <div className="rounded-md border divide-y bg-card">
        {visible.map((instance) => {
          if (!isProviderType(instance.type)) return null;
          const isSingleton = SINGLETON_TYPES.has(instance.type);
          const isMock = instance.type === PROVIDER_TYPES.mock;
          if (isMock) {
            return <MockRow key={instance.id} instance={instance} />;
          }
          if (isSingleton) {
            // Whisper system row: Edit (manage downloads), Delete
            // (purge everything).
            return (
              <Row
                key={instance.id}
                instance={instance}
                onEditClick={onOpenWhisperManager}
                onDeleteClick={() =>
                  setRemoveTarget({ kind: "whisper-all", instance })
                }
              />
            );
          }
          // Cloud row: Edit (creds), Delete (instance). Adding another
          // instance of the same type happens via the Available tiles
          // below — no point duplicating the entry point in this menu.
          return (
            <Row
              key={instance.id}
              instance={instance}
              onEditClick={() => onEdit(instance.id)}
              onDeleteClick={() =>
                setRemoveTarget({ kind: "cloud", instance })
              }
            />
          );
        })}
      </div>

      <AlertDialog
        open={!!removeTarget}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <AlertDialogContent>
          {removeTarget?.kind === "cloud" && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Remove {removeTarget.instance.label}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  The instance and any defaults pointing at it will be cleared.
                  You can add it again any time.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleConfirmRemove}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Remove
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
          {removeTarget?.kind === "whisper-all" && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete all Whisper models?</AlertDialogTitle>
                <AlertDialogDescription>
                  Every downloaded Whisper model file will be removed from
                  disk. The transcription default may be cleared if it pointed
                  at one of these models. You can re-download any time.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleConfirmRemove}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete all
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
  onEditClick: () => void;
  onDeleteClick: () => void;
}

function Row({ instance, onEditClick, onDeleteClick }: RowProps) {
  if (!isProviderType(instance.type)) return null;
  const meta = PROVIDER_META[instance.type];
  const preview = configPreview(instance.type, instance.config);
  const isSingleton = SINGLETON_TYPES.has(instance.type);

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40">
      <meta.Logo className={`size-4 shrink-0 ${meta.tint ?? ""}`} />
      <span className="text-sm font-medium truncate flex-1 min-w-0">
        {meta.label}
        {!isSingleton && (
          <span className="text-muted-foreground"> · {instance.label}</span>
        )}
      </span>
      <span className="text-xs text-muted-foreground truncate font-mono shrink-0 max-w-[40%]">
        {preview}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            aria-label={`${instance.label} options`}
          >
            <Pencil className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onClick={onEditClick}>
            {isSingleton ? (
              <>
                <Settings2 className="mr-2 size-3.5" />
                Manage
              </>
            ) : (
              <>
                <Pencil className="mr-2 size-3.5" />
                Edit
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={onDeleteClick}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 size-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

interface MockRowProps {
  instance: Instance;
}

// Mock has no actions worth surfacing — it's a dev-only sanity row.
// Render the row but skip the menu trigger entirely.
function MockRow({ instance }: MockRowProps) {
  if (!isProviderType(instance.type)) return null;
  const meta = PROVIDER_META[instance.type];
  const preview = configPreview(instance.type, instance.config);

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40">
      <meta.Logo className={`size-4 shrink-0 ${meta.tint ?? ""}`} />
      <span className="text-sm font-medium truncate flex-1 min-w-0">
        {meta.label}
      </span>
      <span className="text-xs text-muted-foreground truncate shrink-0 max-w-[40%]">
        {preview}
      </span>
    </div>
  );
}
