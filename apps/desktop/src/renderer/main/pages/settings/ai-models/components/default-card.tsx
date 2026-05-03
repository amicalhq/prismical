"use client";
import { ComponentType } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/trpc/react";
import {
  isProviderType,
  PROVIDER_TYPE_MULTI_INSTANCE,
} from "@/constants/provider-types";
import { PROVIDER_META } from "@/renderer/main/components/provider-meta";

type UseCase = "transcription" | "formatting";

interface DefaultCardProps {
  useCase: UseCase;
  title: string;
  /** One-line explanation of what this default model is used for in
   *  prismical. Sits under the title to orient users who don't yet
   *  have a mental model for what each use case does. */
  description: string;
  Icon: ComponentType<{ className?: string }>;
  onChange: () => void;
}

// Hero card for one model-default use case. Three vertical bands:
//
//   1. Title + description (orient the user)
//   2. Selected model panel (or empty-state warning)
//   3. Change/Choose button, right-aligned
//
// Display only — no catalog fetches happen here. The model name
// shown is the raw modelId, which reads acceptably for the providers
// we support today.
export default function DefaultCard({
  useCase,
  title,
  description,
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
  const hasSelection = !!selection && !!instance;

  return (
    // Override Card's default py-6 — it stacks on top of CardContent's
    // padding and produces a 40px-tall dead band above and below the
    // content. py-4 + px-4 gives a tight, uniform 16px frame.
    <Card className="py-4 gap-3">
      <CardContent className="px-4 space-y-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Icon className="size-4 text-muted-foreground" />
            {title}
          </h3>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            {description}
          </p>
        </div>

        {isLoading ? (
          <div className="rounded-md border bg-muted/30 p-3 h-[58px]" />
        ) : hasSelection && meta ? (
          <div className="rounded-md border bg-muted/40 p-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <meta.Logo
                className={`size-5 shrink-0 ${meta.tint ?? ""}`}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold truncate">
                  {selection.modelId}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {meta.label}
                  {/* Singletons (Whisper, Mock) carry a seeded label
                      that's effectively a placeholder — appending
                      "· Local" after "Whisper" is just noise. Only
                      show the user-supplied label for multi-instance
                      providers where it actually disambiguates. */}
                  {instance &&
                    isProviderType(instance.type) &&
                    PROVIDER_TYPE_MULTI_INSTANCE[instance.type] && (
                      <> · {instance.label}</>
                    )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-amber-700 dark:text-amber-400">
                  {selection
                    ? "Previous selection unavailable"
                    : "No model selected"}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {useCase === "transcription"
                    ? "Pick a model to enable transcription."
                    : "Pick a model to enable note generation."}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={onChange}>
            {hasSelection ? "Change model" : "Choose model"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
