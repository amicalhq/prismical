'use client';

import * as React from 'react';
import { Check, ChevronsUpDown, Mic } from 'lucide-react';
import { Card, CardContent } from '../../ui/card';
import { Label } from '../../ui/label';
import { Separator } from '../../ui/separator';
import { Switch } from '../../ui/switch';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../../ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import { cn } from '../../lib/utils';
import {
  DEFAULT_MICROPHONE_DEVICE_ID,
  mergeConnectedMicrophones,
  promoteMicrophone,
  resolveActiveMicrophone,
  useDesktopCapabilities,
  useMicrophoneDevices,
  useRecordingPreferences,
} from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

// A representative subset of the desktop AVAILABLE_LANGUAGES (minus "auto",
// which is now the toggle above the picker).
const LANGUAGES = [
  { value: 'en', flag: '🇺🇸' },
  { value: 'zh', flag: '🇨🇳' },
  { value: 'es', flag: '🇪🇸' },
  { value: 'fr', flag: '🇫🇷' },
  { value: 'de', flag: '🇩🇪' },
  { value: 'ja', flag: '🇯🇵' },
  { value: 'ko', flag: '🇰🇷' },
  { value: 'pt', flag: '🇵🇹' },
  { value: 'it', flag: '🇮🇹' },
  { value: 'ru', flag: '🇷🇺' },
  { value: 'ar', flag: '🇸🇦' },
  { value: 'hi', flag: '🇮🇳' },
  { value: 'nl', flag: '🇳🇱' },
  { value: 'pl', flag: '🇵🇱' },
  { value: 'tr', flag: '🇹🇷' },
  { value: 'sv', flag: '🇸🇪' },
  { value: 'da', flag: '🇩🇰' },
  { value: 'fi', flag: '🇫🇮' },
  { value: 'el', flag: '🇬🇷' },
  { value: 'he', flag: '🇮🇱' },
  { value: 'th', flag: '🇹🇭' },
  { value: 'vi', flag: '🇻🇳' },
  { value: 'id', flag: '🇮🇩' },
  { value: 'cs', flag: '🇨🇿' },
] as const;

// Searchable language combobox (mirrors the desktop dictation Combobox). The
// whole control is disabled when auto-detect is on.
function LanguageCombobox({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const selected = LANGUAGES.find(l => l.value === value);

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
            {selected
              ? `${selected.flag} ${t(`settings.transcription.languages.${selected.value}`)}`
              : t('settings.transcription.language.placeholder')}
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
              {LANGUAGES.map(lang => {
                const label = `${lang.flag} ${t(`settings.transcription.languages.${lang.value}`)}`;
                return (
                  <CommandItem
                    key={lang.value}
                    value={label}
                    keywords={[lang.value]}
                    onSelect={() => {
                      onChange(lang.value);
                      setOpen(false);
                    }}
                    className="flex items-center gap-2"
                  >
                    <Check
                      className={cn(
                        'h-4 w-4 shrink-0',
                        value === lang.value ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    <span className="flex-1 truncate">{label}</span>
                  </CommandItem>
                );
              })}
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

  if (isDesktop) {
    return (
      <div>
        <div className="mb-8">
          <h1 className="text-xl font-bold">{t('settings.transcription.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('settings.transcription.description')}
          </p>
        </div>
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
    );
  }

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
            {/* Auto-detect language */}
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label className="text-base font-semibold text-foreground">
                  {t('settings.transcription.autoDetectLabel')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('settings.transcription.autoDetectDescription')}
                </p>
              </div>
              <Switch
                checked={preferences.autoDetectLanguage}
                onCheckedChange={on => setPreferences({ autoDetectLanguage: on })}
              />
            </div>

            {/* Language picker — disabled while auto-detect is on */}
            <div className="flex items-start justify-between rounded-md border border-border p-4">
              <div
                className={cn(
                  'flex flex-col gap-2',
                  preferences.autoDetectLanguage && 'pointer-events-none opacity-50'
                )}
              >
                <Label className="text-sm font-medium text-foreground">
                  {t('settings.transcription.language.label')}
                </Label>
              </div>
              <Tooltip delayDuration={100}>
                <TooltipTrigger asChild>
                  <div>
                    <LanguageCombobox
                      value={preferences.language}
                      onChange={language => setPreferences({ language })}
                      disabled={preferences.autoDetectLanguage}
                    />
                  </div>
                </TooltipTrigger>
                {preferences.autoDetectLanguage && (
                  <TooltipContent className="max-w-sm text-center">
                    {t('settings.transcription.language.selectHint')}
                  </TooltipContent>
                )}
              </Tooltip>
            </div>

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

            <p className="text-xs text-muted-foreground">
              {t('settings.transcription.nextRecording')}
            </p>
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}

/** Backward-compatible export for existing route and file imports. */
export const DictationScreen = TranscriptionScreen;
