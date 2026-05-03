"use client";
import { ComponentType } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/trpc/react";
import { isProviderType } from "@/constants/provider-types";
import { PROVIDER_META } from "@/renderer/main/components/provider-meta";

type UseCase = "transcription" | "formatting";

interface DefaultCardProps {
  useCase: UseCase;
  title: string;
  Icon: ComponentType<{ className?: string }>;
  onChange: () => void;
}

// Hero card for one model-default use case. Renders the currently
// selected instance + model (or a "no model selected" empty state),
// plus a [Change] / [Choose] button that opens ChangeDefaultDialog.
//
// Display only — no catalog fetches happen here. The model's
// human-readable name is the modelId itself (good enough for the
// providers we support; OpenAI/Groq/Whisper IDs are already
// presentable). When/if we want pretty names without a catalog
// fetch we can cache the most-recently-fetched name on the
// modelDefaults entry.
export default function DefaultCard({
  useCase,
  title,
  Icon,
  onChange,
}: DefaultCardProps) {
  const defaultsQuery = api.instances.getDefaults.useQuery();
  const instancesQuery = api.instances.list.useQuery();

  const selection = defaultsQuery.data?.[useCase];
  const instance = selection
    ? instancesQuery.data?.find((i) => i.id === selection.instanceId)
    : undefined;

  const meta =
    instance && isProviderType(instance.type)
      ? PROVIDER_META[instance.type]
      : undefined;

  const isLoading = defaultsQuery.isLoading || instancesQuery.isLoading;

  return (
    <Card>
      <CardContent className="p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Icon className="size-4" />
          {title}
        </div>

        {isLoading ? (
          <div className="h-10" />
        ) : selection && instance ? (
          <div className="flex items-center gap-2">
            {meta && <meta.Logo className="size-5 shrink-0" />}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold truncate">
                {selection.modelId}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {meta?.label ?? instance.type} · {instance.label}
              </div>
            </div>
          </div>
        ) : selection && !instance ? (
          // Default points at an instance that no longer exists. The
          // backend's clearDefaultsForInstance hook should have caught
          // this on remove; surface it explicitly anyway so the user
          // can re-pick.
          <div className="text-sm text-muted-foreground italic">
            Previous selection unavailable
          </div>
        ) : (
          <div className="text-sm text-muted-foreground italic">
            No model selected
          </div>
        )}

        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={onChange}>
            {selection ? "Change" : "Choose"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
