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

// Hero card for one model-default use case. Compact two-row layout:
//
//   [icon] Title                              [Change]
//   [logo] modelId                            instance.label
//
// Display only — no catalog fetches happen here. The model name shown
// is the raw modelId, which reads acceptably for the providers we
// support today (gpt-4o, whisper-large-v3-turbo, etc).
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
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            <Icon className="size-3.5" />
            {title}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={onChange}
            className="h-7 -mr-1 px-2 text-xs"
          >
            {selection ? "Change" : "Choose"}
          </Button>
        </div>

        {isLoading ? (
          <div className="h-9" />
        ) : selection && instance ? (
          <div className="flex items-center gap-2 min-w-0">
            {meta && <meta.Logo className="size-4 shrink-0" />}
            <span className="text-sm font-medium truncate">
              {selection.modelId}
            </span>
            <span className="text-xs text-muted-foreground truncate">
              · {instance.label}
            </span>
          </div>
        ) : selection && !instance ? (
          // Default points at an instance that no longer exists. Backend
          // clears defaults on instance remove, but surface it just in
          // case (e.g., DB edited externally).
          <div className="text-sm text-muted-foreground italic">
            Previous selection unavailable
          </div>
        ) : (
          <div className="text-sm text-muted-foreground italic">
            No model selected
          </div>
        )}
      </CardContent>
    </Card>
  );
}
