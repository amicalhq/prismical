"use client";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/trpc/react";
import { toast } from "sonner";

/**
 * Dev-only mock provider section. Gated by NODE_ENV !== "production" at the
 * call-site (LanguageTab). Syncs a single canned language model so the
 * note-generation and formatting pipelines can be exercised locally without
 * a real LLM provider configured.
 */
export default function MockProviderDevSection() {
  const utils = api.useUtils();
  const syncedModelsQuery = api.models.getSyncedProviderModels.useQuery();
  const mockModels = (syncedModelsQuery.data ?? []).filter(
    (m) => m.provider === "Mock",
  );
  const enabled = mockModels.length > 0;

  const invalidate = () => {
    utils.models.getSyncedProviderModels.invalidate();
    utils.models.getDefaultLanguageModel.invalidate();
  };

  const enableMutation = api.models.enableMockProvider.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success("Mock provider enabled");
    },
    onError: (error) => toast.error(`Failed to enable mock: ${error.message}`),
  });

  const disableMutation = api.models.disableMockProvider.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success("Mock provider disabled");
    },
    onError: (error) => toast.error(`Failed to disable mock: ${error.message}`),
  });

  const pending = enableMutation.isPending || disableMutation.isPending;

  return (
    <div className="rounded-md border border-dashed p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Mock provider</span>
            <Badge variant="secondary" className="text-xs">
              dev only
            </Badge>
            <Badge
              variant="secondary"
              className={cn(
                "text-xs flex items-center gap-1",
                enabled
                  ? "text-green-500 border-green-500"
                  : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "w-2 h-2 rounded-full inline-block mr-1",
                  enabled ? "bg-green-500" : "bg-muted-foreground",
                )}
              />
              {enabled ? "enabled" : "disabled"}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Registers a canned language model that returns a fixed markdown
            summary. Useful for testing the pipeline without calling a real
            LLM. Select it as the default language model after enabling.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            enabled ? disableMutation.mutate() : enableMutation.mutate()
          }
        >
          {pending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {enabled ? "Disabling" : "Enabling"}
            </>
          ) : enabled ? (
            "Disable"
          ) : (
            "Enable"
          )}
        </Button>
      </div>
    </div>
  );
}
