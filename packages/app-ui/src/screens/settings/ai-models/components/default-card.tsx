'use client';

import { type ComponentType } from 'react';
import { AlertTriangle, Sparkles } from 'lucide-react';

import { Button } from '../../../../ui/button';
import { Card, CardContent } from '../../../../ui/card';
import { modelDisplayName, type UseCase } from '../../mock-data';
import {
  isProviderType,
  PROVIDER_META,
  PROVIDER_TYPE_MULTI_INSTANCE,
} from '../../../../lib/providers';
import { PRISMICAL_CLOUD_INSTANCE_ID } from '@prismical/app-client';

import { useAIModels } from './ai-models-store';
import { useTranslation } from 'react-i18next';

interface DefaultCardProps {
  useCase: UseCase;
  title: string;
  /** One-line explanation of what this default model is used for. */
  description: string;
  Icon: ComponentType<{ className?: string }>;
  onChange: () => void;
}

// Hero card for one model-default use case. Three vertical bands:
//   1. Title + description (orient the user)
//   2. Selected model panel — managed Auto (Prismical Cloud, the default when no BYOK pick), a BYOK
//      instance+model, or (rare fallback) an empty-state warning
//   3. Change button, right-aligned
// No scope badges — the org-vs-override choice lives inside the Change dialog.
export default function DefaultCard({
  useCase,
  title,
  description,
  Icon,
  onChange,
}: DefaultCardProps) {
  const { t } = useTranslation();
  const { defaults, getInstance } = useAIModels();

  const selection = defaults[useCase];
  const isManaged = selection?.instanceId === PRISMICAL_CLOUD_INSTANCE_ID;
  const instance = selection && !isManaged ? getInstance(selection.instanceId) : undefined;
  const meta =
    instance && isProviderType(instance.provider) ? PROVIDER_META[instance.provider] : undefined;

  return (
    // Override Card's default py-6 — py-4 + px-4 gives a tight 16px frame.
    <Card className="py-4 gap-3">
      <CardContent className="px-4 space-y-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Icon className="size-4 text-muted-foreground" />
            {title}
          </h3>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{description}</p>
        </div>

        {isManaged ? (
          <div className="rounded-md border bg-muted p-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Sparkles className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold truncate">
                  {t('settings.aiModels.managedAutoShort')}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {t('settings.aiModels.defaultCard.managedBy')}
                </div>
              </div>
            </div>
          </div>
        ) : meta && instance && selection ? (
          <div className="rounded-md border bg-muted p-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <meta.Logo className={`size-5 shrink-0 ${meta.tint ?? ''}`} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold truncate">
                  {modelDisplayName(instance, selection.modelId)}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {meta.label}
                  {/* Only show the user-supplied label for multi-instance
                      providers where it actually disambiguates. */}
                  {isProviderType(instance.provider) &&
                    PROVIDER_TYPE_MULTI_INSTANCE[instance.provider] && <> · {instance.label}</>}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-warning/30 bg-warning/5 p-3">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="size-4 text-warning shrink-0 mt-0.5" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-warning">
                  {t('settings.aiModels.defaultCard.unavailableTitle')}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {t('settings.aiModels.defaultCard.unavailableDescription')}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={onChange}>
            {t('settings.aiModels.defaultCard.change')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
