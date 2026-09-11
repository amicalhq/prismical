'use client';

import * as React from 'react';
import { Check, ChevronsUpDown, Mic } from 'lucide-react';
import { Card, CardContent } from '../../ui/card';
import { Label } from '../../ui/label';
import { Separator } from '../../ui/separator';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../../ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { TooltipProvider } from '../../ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import { cn } from '../../lib/utils';
import { transcriptionLanguageOptions } from '../../lib/transcription-language-name';
import { Button } from '../../ui/button';
import {
  DEFAULT_MICROPHONE_DEVICE_ID,
  mergeConnectedMicrophones,
  promoteMicrophone,
  resolveActiveMicrophone,
  useDesktopCapabilities,
  useMicrophoneDevices,
  useRecordingPreferences,
  useTranscriptionPreference,
  type TranscriptionLanguage,
} from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

// Searchable language combobox (mirrors the desktop dictation Combobox). Names come from the
// platform's language table in the interface locale; the mixed entry is labelled by the catalog.
export function LanguageCombobox({
  value,
  onChange,
  disabled,
}: {
  value: TranscriptionLanguage | undefined;
  onChange: (v: TranscriptionLanguage) => void;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const options = React.useMemo(() => transcriptionLanguageOptions(i18n.language), [i18n.language]);
  const selected = options.find(l => l.code === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t('settings.transcription.language.aria')}
          className="flex h-9 w-[220px] items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="truncate">
            {selected ? selected.name : t('settings.transcription.language.placeholder')}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[220px] p-0">
        <Command>
          <CommandInput placeholder={t('settings.transcription.language.search')} />
          <CommandList>
            <CommandEmpty>{t('settings.transcription.language.empty')}</CommandEmpty>
            <CommandGroup>
              {options.map(lang => (
                <CommandItem
                  key={lang.code}
                  value={lang.name}
                  keywords={[lang.code]}
                  onSelect={() => {
                    onChange(lang.code);
                    setOpen(false);
                  }}
                  className="flex items-center gap-2"
                >
                  <Check
                    className={cn(
                      'h-4 w-4 shrink-0',
                      value === lang.code ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className="flex-1 truncate">{lang.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * `engineSettings`: the platform's transcription-engine
 * controls, rendered in the desktop branch in place of the placeholder card.
 * A named slot, not an environment branch — desktop's router passes its
 * desktop-owned engine card; web passes nothing and is unchanged.
 */
export function TranscriptionScreen({ engineSettings }: { engineSettings?: React.ReactNode } = {}) {
  const { t } = useTranslation();
  const isDesktop = useDesktopCapabilities().has('global-shortcuts');
  const [preferences, setPreferences] = useRecordingPreferences();
  const spoken = useTranscriptionPreference();
  const microphones = useMicrophoneDevices(!isDesktop);
  const microphoneOptions = microphones.length
    ? microphones
    : [
        {
          deviceId: DEFAULT_MICROPHONE_DEVICE_ID,
          label: t('settings.transcription.systemDefault'),
          isDefault: true,
        },
      ];
  const activeMicrophone = resolveActiveMicrophone(
    preferences.microphonePriority,
    microphoneOptions
  );

  return (
    <TooltipProvider>
      <div>
        <div className="mb-8">
          <h1 className="text-xl font-bold">{t('settings.transcription.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('settings.transcription.description')}
          </p>
        </div>

        <Card>
          <CardContent className="space-y-4">
            {/* Spoken language: the account's choice, shared with the recording panel's gear. */}
            <div className="flex items-start justify-between gap-6">
              <div className="min-w-0 space-y-1">
                <Label className="text-base font-semibold text-foreground">
                  {t('settings.transcription.language.label')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('settings.transcription.language.description')}
                </p>
              </div>
              <LanguageCombobox
                value={spoken?.language}
                onChange={language => {
                  void spoken?.setLanguage(language).catch(() => {});
                }}
                disabled={!spoken || spoken.isPending}
              />
            </div>
            {spoken?.error && (
              <div role="alert" className="text-sm text-destructive">
                {t('settings.transcription.language.saveError')}
                <Button variant="ghost" size="sm" onClick={spoken.retry}>
                  {t('settings.transcription.language.retry')}
                </Button>
              </div>
            )}

            {!isDesktop && (
              <>
                <Separator />

                {/* Microphone */}
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label
                      htmlFor="dictation-microphone"
                      className="text-base font-semibold text-foreground"
                    >
                      {t('settings.transcription.microphoneLabel')}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t('settings.transcription.microphoneDescription')}
                    </p>
                  </div>
                  <Select
                    value={activeMicrophone}
                    onValueChange={deviceId =>
                      setPreferences({
                        microphonePriority: promoteMicrophone(
                          mergeConnectedMicrophones(preferences.microphonePriority, microphoneOptions),
                          microphoneOptions.find(microphone => microphone.deviceId === deviceId) ??
                            microphoneOptions[0]!
                        ),
                      })
                    }
                  >
                    <SelectTrigger id="dictation-microphone" className="w-[220px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {microphoneOptions.map(microphone => (
                        <SelectItem key={microphone.deviceId} value={microphone.deviceId}>
                          <div className="flex items-center gap-2">
                            <Mic className="h-4 w-4" />
                            <span>{microphone.label}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}

            <p className="text-xs text-muted-foreground">
              {t('settings.transcription.nextRecording')}
            </p>
          </CardContent>
        </Card>
        {isDesktop && (
          <div className="mt-6">
            {engineSettings ?? (
              <Card>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.transcription.desktopNotice')}
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

/** Backward-compatible export for existing route and file imports. */
export const DictationScreen = TranscriptionScreen;
