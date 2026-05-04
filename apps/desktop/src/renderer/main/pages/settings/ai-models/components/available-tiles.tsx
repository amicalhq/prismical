"use client";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  PROVIDER_TYPES,
  PROVIDER_TYPE_COMING_SOON,
  PROVIDER_TYPE_MULTI_INSTANCE,
  isProviderType,
  type ProviderType,
} from "@/constants/provider-types";
import { PROVIDER_META } from "@/renderer/main/components/provider-meta";

interface AvailableTilesProps {
  /** Open the credential form for a brand-new cloud instance. */
  onAddCloud: (type: ProviderType) => void;
  /** Open the Whisper download manager. */
  onOpenWhisperManager: () => void;
}

// Display order for the Available tiles. Three bands:
//   1. Local Whisper (flagship on-device option)
//   2. Implemented cloud / compat / dev tiles
//   3. Coming-soon tiles (disabled, with tooltip)
// Hand-tuned — adjust here only.
const TILE_ORDER: ProviderType[] = [
  // Implemented
  PROVIDER_TYPES.localWhisper,
  PROVIDER_TYPES.openai,
  PROVIDER_TYPES.openRouter,
  PROVIDER_TYPES.ollama,
  PROVIDER_TYPES.openAICompatible,
  PROVIDER_TYPES.mock,
  // Coming soon (in roadmap order — no strong opinion yet)
  PROVIDER_TYPES.anthropic,
  PROVIDER_TYPES.groq,
  PROVIDER_TYPES.googleGemini,
  PROVIDER_TYPES.vercelAIGateway,
  PROVIDER_TYPES.cloudflareWorkersAI,
  PROVIDER_TYPES.cerebras,
];

// Slim icon + name + plus tiles. Implemented cloud types route the
// click to InstanceFormDialog; Whisper opens its own manage dialog;
// coming-soon types render disabled with a "Coming soon" tooltip
// so users can see the roadmap. Mock stays gated to dev builds.
export default function AvailableTiles({
  onAddCloud,
  onOpenWhisperManager,
}: AvailableTilesProps) {
  const isDev = process.env.NODE_ENV !== "production";

  const visibleTypes = TILE_ORDER.filter((type) => {
    if (type === PROVIDER_TYPES.mock) return isDev;
    return true;
  });

  return (
    <TooltipProvider delayDuration={150}>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
        {visibleTypes.map((type) => {
          if (!isProviderType(type)) return null;
          const meta = PROVIDER_META[type];
          const isMulti = PROVIDER_TYPE_MULTI_INSTANCE[type];
          const isComingSoon = PROVIDER_TYPE_COMING_SOON[type];

          const handleClick = () => {
            if (isComingSoon) return;
            if (type === PROVIDER_TYPES.localWhisper) {
              onOpenWhisperManager();
            } else if (type === PROVIDER_TYPES.mock) {
              // Mock has no config to set; the bootstrap seeds it.
              return;
            } else {
              onAddCloud(type);
            }
          };

          const isInteractive =
            !isComingSoon &&
            (type === PROVIDER_TYPES.localWhisper || isMulti);

          const tile = (
            <Button
              type="button"
              variant="outline"
              onClick={handleClick}
              disabled={!isInteractive}
              className="h-auto w-full justify-between gap-2 px-3 py-2"
            >
              <div className="flex items-center gap-2 min-w-0">
                <meta.Logo className={`size-4 shrink-0 ${meta.tint ?? ""}`} />
                <span className="text-sm truncate">{meta.label}</span>
              </div>
              <Plus className="size-3.5 shrink-0 text-muted-foreground" />
            </Button>
          );

          if (!isComingSoon) return <div key={type}>{tile}</div>;

          // Tooltip needs a non-disabled wrapper to register hover
          // events — disabled buttons swallow them. Wrap in a span
          // with pointer-events: auto so the tooltip still triggers.
          return (
            <Tooltip key={type}>
              <TooltipTrigger asChild>
                <span className="inline-block w-full">{tile}</span>
              </TooltipTrigger>
              <TooltipContent>Coming soon</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
