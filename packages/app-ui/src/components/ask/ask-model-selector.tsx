'use client';

import * as React from 'react';
import { Check, ChevronsUpDown, Settings2, Sparkles } from 'lucide-react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../../ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { cn } from '../../lib/utils';
import { PROVIDER_META, type ProviderType } from '../../lib/providers';
import {
  findOption,
  PRISMICAL_CLOUD_INSTANCE_ID,
  useNavigation,
  type AskModelGroup,
  type AskModelSelection,
} from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

/** Provider glyph: the Prismical sparkle for managed Cloud, else the instance's provider logo. */
function GroupIcon({ provider, className }: { provider: string; className?: string }) {
  if (provider === PRISMICAL_CLOUD_INSTANCE_ID) return <Sparkles className={className} />;
  const meta = PROVIDER_META[provider as ProviderType];
  if (!meta) return <Sparkles className={className} />;
  return <meta.Logo className={cn(className, meta.tint)} />;
}

/**
 * Cursor-style model picker for the Ask composer footer: a compact trigger showing the current model,
 * opening a searchable popover grouped by provider instance (Prismical Cloud → Auto, then each BYOK
 * instance → its curated models). Selecting one calls `onChange`; the parent persists + sends it.
 */
export function AskModelSelector({
  groups,
  value,
  onChange,
  compact = false,
}: {
  groups: AskModelGroup[];
  value: AskModelSelection;
  onChange: (sel: AskModelSelection) => void;
  /** Float window: hide the settings footer — this surface rides the same
   * router, and navigating it to the full settings page strands a 380px
   * always-on-top window inside the AppShell with no way back. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const router = useNavigation();
  const [open, setOpen] = React.useState(false);
  const current = findOption(groups, value);
  const currentProvider =
    groups.find(g => g.options.some(o => o.instanceId === value.instanceId))?.provider ??
    PRISMICAL_CLOUD_INSTANCE_ID;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('ask.models.select')}
          className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-dock-ink-2 transition-colors hover:bg-dock-hover hover:text-dock-ink"
        >
          <GroupIcon provider={currentProvider} className="size-3.5" />
          <span className="max-w-[140px] truncate">{current?.label ?? t('ask.models.auto')}</span>
          <ChevronsUpDown className="size-3 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={t('ask.models.search')} className="h-9" />
          <CommandList>
            <CommandEmpty>{t('ask.models.noModels')}</CommandEmpty>
            {groups.map(g => (
              <CommandGroup key={g.instanceId} heading={g.label}>
                {g.options.map(o => {
                  const selected = o.instanceId === value.instanceId && o.modelId === value.modelId;
                  return (
                    <CommandItem
                      key={`${o.instanceId}:${o.modelId}`}
                      value={`${g.label} ${o.label}`}
                      onSelect={() => {
                        onChange({ instanceId: o.instanceId, modelId: o.modelId });
                        setOpen(false);
                      }}
                    >
                      <GroupIcon provider={g.provider} className="size-3.5" />
                      <span className="truncate">{o.label}</span>
                      {selected && <Check className="ml-auto size-3.5" />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
        {/* Footer OUTSIDE the Command so the search filter can never hide it —
            the jump to instance/model management (/settings/ai-models). App
            tokens, not dock tokens: this popover is a stock app surface. */}
        {!compact ? (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              router.push('/settings/ai-models');
            }}
            className="flex w-full cursor-pointer items-center gap-2 border-t px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Settings2 className="size-3.5" />
            {t('ask.models.settings')}
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
