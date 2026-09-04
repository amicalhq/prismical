'use client';

import * as React from 'react';
import { Check, ChevronDown, type LucideIcon } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../../../../ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../../../../ui/popover';
import { cn } from '../../../../lib/utils';
import { useTranslation } from 'react-i18next';

export interface ScopeOption {
  id: string;
  label: string;
  /** Optional swatch (tag colors). */
  color?: string;
}

/**
 * Multi-select combobox for the automation builder's scope filters (folders, tags) in the
 * NotesFolderPicker idiom. Selecting the "Any …" head row clears the selection; selecting any
 * concrete option toggles it. Empty selection === "Any" (no filter dimension).
 */
export function ScopeMultiPicker({
  options,
  value,
  onChange,
  anyLabel,
  searchPlaceholder,
  icon: Icon,
  disabled,
}: {
  options: ScopeOption[];
  value: string[];
  onChange: (ids: string[]) => void;
  anyLabel: string;
  searchPlaceholder: string;
  icon: LucideIcon;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const selected = options.filter(o => value.includes(o.id));
  const label = selected.length ? selected.map(o => o.label).join(', ') : anyLabel;

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter(v => v !== id) : [...value, id]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex h-9 w-full items-center gap-2 rounded-lg border border-input bg-background px-3 text-sm transition-colors hover:bg-accent disabled:opacity-50"
        >
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span
            className={cn('flex-1 truncate text-left', !selected.length && 'text-muted-foreground')}
          >
            {label}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{t('settings.automations.dialog.nothingFound')}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={anyLabel}
                onSelect={() => onChange([])}
                className="flex items-center gap-2"
              >
                <Check className={cn('h-4 w-4', value.length ? 'opacity-0' : 'opacity-100')} />
                {anyLabel}
              </CommandItem>
              {options.map(o => (
                <CommandItem
                  key={o.id}
                  value={o.label}
                  onSelect={() => toggle(o.id)}
                  className="flex items-center gap-2"
                >
                  <Check
                    className={cn('h-4 w-4', value.includes(o.id) ? 'opacity-100' : 'opacity-0')}
                  />
                  {o.color ? (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: o.color }}
                    />
                  ) : (
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{o.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
