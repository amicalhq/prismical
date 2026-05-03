"use client";
import { useState } from "react";
import { Pencil, Settings2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  /** Open the Edit form dialog with the given instance id. */
  onEdit: (id: string) => void;
  /** Open the Whisper download manager. */
  onOpenWhisperManager: () => void;
}

const SINGLETON_TYPES = new Set<ProviderType>(
  Object.keys(SINGLETON_INSTANCE_IDS) as ProviderType[],
);

// Display order for connected rows: local Whisper first (flagship),
// cloud providers next (server-insertion order, which mirrors creation
// order for the user), then Mock at the very end (dev-only). Returns
// a comparator suitable for Array.prototype.sort.
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

export default function ConnectedList({
  onEdit,
  onOpenWhisperManager,
}: ConnectedListProps) {
  const [confirmRemove, setConfirmRemove] = useState<Instance | null>(null);
  const utils = api.useUtils();

  const instancesQuery = api.instances.list.useQuery();

  const removeMutation = api.instances.remove.useMutation({
    onSuccess: () => {
      toast.success("Instance removed");
      utils.instances.list.invalidate();
      utils.instances.listByType.invalidate();
      utils.instances.getDefaults.invalidate();
      setConfirmRemove(null);
    },
    onError: (error) => {
      toast.error(`Couldn't remove instance: ${error.message}`);
      setConfirmRemove(null);
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

  return (
    <>
      <div className="rounded-md border divide-y bg-card">
        {visible.map((instance) => {
          const isSingleton = SINGLETON_TYPES.has(instance.type as ProviderType);
          if (isSingleton) {
            return (
              <SystemRow
                key={instance.id}
                instance={instance}
                onManage={
                  instance.type === PROVIDER_TYPES.localWhisper
                    ? onOpenWhisperManager
                    : undefined
                }
              />
            );
          }
          return (
            <CloudRow
              key={instance.id}
              instance={instance}
              onEdit={() => onEdit(instance.id)}
              onRemove={() => setConfirmRemove(instance)}
            />
          );
        })}
      </div>

      <AlertDialog
        open={!!confirmRemove}
        onOpenChange={(open) => {
          if (!open) setConfirmRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {confirmRemove?.label ?? "instance"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The instance and any defaults pointing at it will be cleared. You
              can add it again any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmRemove)
                  removeMutation.mutate({ id: confirmRemove.id });
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface CloudRowProps {
  instance: Instance;
  onEdit: () => void;
  onRemove: () => void;
}

function CloudRow({ instance, onEdit, onRemove }: CloudRowProps) {
  if (!isProviderType(instance.type)) return null;
  const meta = PROVIDER_META[instance.type];
  const preview = configPreview(instance.type, instance.config);

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40">
      <meta.Logo className={`size-4 shrink-0 ${meta.tint ?? ""}`} />
      <div className="min-w-0 flex-1 flex items-baseline gap-2">
        <span className="text-sm font-medium truncate">
          {meta.label} · {instance.label}
        </span>
        <span className="text-xs text-muted-foreground truncate font-mono">
          {preview}
        </span>
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={onEdit}
          aria-label={`Edit ${instance.label}`}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-destructive hover:text-destructive"
          onClick={onRemove}
          aria-label={`Remove ${instance.label}`}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

interface SystemRowProps {
  instance: Instance;
  onManage?: () => void;
}

function SystemRow({ instance, onManage }: SystemRowProps) {
  if (!isProviderType(instance.type)) return null;
  const meta = PROVIDER_META[instance.type];
  const preview = configPreview(instance.type, instance.config);

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40">
      <meta.Logo className={`size-4 shrink-0 ${meta.tint ?? ""}`} />
      <div className="min-w-0 flex-1 flex items-baseline gap-2">
        <span className="text-sm font-medium truncate">{meta.label}</span>
        <span className="text-xs text-muted-foreground truncate">
          {preview}
        </span>
      </div>
      {onManage && (
        <Button
          size="sm"
          variant="ghost"
          onClick={onManage}
          className="h-7 gap-1 text-xs shrink-0"
        >
          <Settings2 className="size-3.5" />
          Manage
        </Button>
      )}
    </div>
  );
}
