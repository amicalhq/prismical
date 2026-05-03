"use client";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  PROVIDER_TYPES,
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

// Display order for the Available tiles. Local Whisper leads as the
// flagship on-device option; cloud providers follow. Mock stays at
// the end (dev-only debug tile). Ordering is hand-tuned — adjust here.
const TILE_ORDER: ProviderType[] = [
  PROVIDER_TYPES.localWhisper,
  PROVIDER_TYPES.openai,
  PROVIDER_TYPES.anthropic,
  PROVIDER_TYPES.groq,
  PROVIDER_TYPES.openRouter,
  PROVIDER_TYPES.ollama,
  PROVIDER_TYPES.openAICompatible,
  PROVIDER_TYPES.mock,
];

// Slim icon + name + plus tiles. Multi-instance cloud types are
// always present (you can always add another). Singletons (whisper,
// mock) are also present always — clicking [+] for a singleton
// updates the existing system instance instead of creating a new
// one (whisper -> downloads model files; mock is no-op).
//
// Mock is dev-only. Whisper opens its own manage dialog; cloud
// types open the InstanceFormDialog in create mode.
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
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
      {visibleTypes.map((type) => {
        if (!isProviderType(type)) return null;
        const meta = PROVIDER_META[type];
        const isMulti = PROVIDER_TYPE_MULTI_INSTANCE[type];

        const handleClick = () => {
          if (type === PROVIDER_TYPES.localWhisper) {
            onOpenWhisperManager();
          } else if (type === PROVIDER_TYPES.mock) {
            // Mock has no config to set; the bootstrap seeds it. The
            // tile is informational in dev — click is a no-op.
            return;
          } else {
            onAddCloud(type);
          }
        };

        const isClickable =
          type === PROVIDER_TYPES.localWhisper || isMulti;

        return (
          <Button
            key={type}
            type="button"
            variant="outline"
            onClick={handleClick}
            disabled={!isClickable}
            className="h-auto justify-between gap-2 px-3 py-2"
          >
            <div className="flex items-center gap-2 min-w-0">
              <meta.Logo className={`size-4 shrink-0 ${meta.tint ?? ""}`} />
              <span className="text-sm truncate">{meta.label}</span>
            </div>
            <Plus className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        );
      })}
    </div>
  );
}
