'use client';

import { Plus } from 'lucide-react';

import { Button } from '../../../../ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../../../ui/tooltip';
import {
  isHiddenProviderType,
  isProviderType,
  PROVIDER_META,
  PROVIDER_TYPE_COMING_SOON,
  PROVIDER_TYPE_MULTI_INSTANCE,
  PROVIDER_TYPES,
  type ProviderType,
} from '../../../../lib/providers';
import { useTranslation } from 'react-i18next';

interface AvailableTilesProps {
  /** Open the credential form for a brand-new cloud instance. */
  onAddCloud: (type: ProviderType) => void;
}

// Display order for the Available tiles. Two bands:
//   1. Implemented cloud / compat / dev tiles
//   2. Coming-soon tiles (disabled, with tooltip)
// Local Whisper uses the real on-device model manager through the desktop
// model-manager port.
const TILE_ORDER: ProviderType[] = [
  // Implemented
  PROVIDER_TYPES.openai,
  PROVIDER_TYPES.openRouter,
  PROVIDER_TYPES.googleGemini,
  PROVIDER_TYPES.ollama,
  PROVIDER_TYPES.openAICompatible,
  PROVIDER_TYPES.mock,
  // Coming soon
  PROVIDER_TYPES.anthropic,
  PROVIDER_TYPES.groq,
  PROVIDER_TYPES.vercelAIGateway,
  PROVIDER_TYPES.cloudflareWorkersAI,
  PROVIDER_TYPES.cerebras,
];

// Slim icon + name + plus tiles. Implemented cloud types route the click to
// InstanceFormDialog; coming-soon cloud types stay visible + disabled.
export default function AvailableTiles({ onAddCloud }: AvailableTilesProps) {
  const { t } = useTranslation();
  const isDev = process.env.NODE_ENV !== 'production';

  const visibleTypes = TILE_ORDER.filter(type => {
    if (isHiddenProviderType(type)) return false;
    if (type === PROVIDER_TYPES.mock) return isDev;
    return true;
  });

  return (
    <TooltipProvider delayDuration={150}>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
        {visibleTypes.map(type => {
          if (!isProviderType(type)) return null;
          const meta = PROVIDER_META[type];
          const isMulti = PROVIDER_TYPE_MULTI_INSTANCE[type];
          const isComingSoon = PROVIDER_TYPE_COMING_SOON[type];

          const handleClick = () => {
            if (isComingSoon) return;
            if (type === PROVIDER_TYPES.mock) {
              // Mock has no config to set.
              return;
            } else {
              onAddCloud(type);
            }
          };

          const isInteractive = !isComingSoon && isMulti;

          const tile = (
            <Button
              type="button"
              variant="outline"
              onClick={handleClick}
              disabled={!isInteractive}
              className="h-auto w-full justify-between gap-2 px-3 py-2"
            >
              <div className="flex items-center gap-2 min-w-0">
                <meta.Logo className={`size-4 shrink-0 ${meta.tint ?? ''}`} />
                <span className="text-sm truncate">{meta.label}</span>
              </div>
              <Plus className="size-3.5 shrink-0 text-muted-foreground" />
            </Button>
          );

          if (!isComingSoon) return <div key={type}>{tile}</div>;

          // Tooltip needs a non-disabled wrapper to register hover events —
          // disabled buttons swallow them. Wrap in a span.
          return (
            <Tooltip key={type}>
              <TooltipTrigger asChild>
                <span className="inline-block w-full">{tile}</span>
              </TooltipTrigger>
              <TooltipContent>{t('settings.aiModels.available.comingSoon')}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
