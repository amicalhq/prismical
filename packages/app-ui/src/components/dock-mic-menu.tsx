'use client';

import * as React from 'react';
import { Check, ChevronDown, Mic, Settings } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import {
  promoteMicrophone,
  resolveActiveMicrophone,
  useMicrophoneDevices,
  useNavigation,
  useRecordingPreferences,
  useTranscriptionPreference,
  type TranscriptionLanguage,
} from '@prismical/app-client';
import { ButtonGroup } from '../ui/button-group';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import { transcriptionLanguageOptions } from '../lib/transcription-language-name';
import { DOCK_CTL, DOCK_MENU_SURFACE } from './dock-chrome';
import { useTranslation } from 'react-i18next';

/**
 * The record panel's input/sound menu: a gear control in the panel's
 * bottom bar that lists the connected microphones (pick = promote to the top
 * of the priority chain, same semantics as the transcription settings screen)
 * plus a jump to the full audio settings. Devices enumerate only while the
 * menu is open — no standing device subscription for a closed menu.
 */
export function DockMicMenu({
  activeLanguage,
  onChangeLanguage,
}: {
  /** The language currently used by an active recording, independent of the account default. */
  activeLanguage?: TranscriptionLanguage;
  /**
   * Called after the account's spoken language changed from this menu, with the new pick, so a
   * running recording can follow it (later chunks and the final pass; not audio already sent).
   */
  onChangeLanguage?: (language: TranscriptionLanguage) => void | Promise<void>;
} = {}) {
  const { t, i18n } = useTranslation();
  const router = useNavigation();
  const [open, setOpen] = React.useState(false);
  const [languageOpen, setLanguageOpen] = React.useState(false);
  const devices = useMicrophoneDevices(open);
  const [preferences, setPreferences] = useRecordingPreferences();
  const activeId = resolveActiveMicrophone(preferences.microphonePriority, devices);
  // Active capture can keep its language when a new account default cannot be applied.
  const spoken = useTranscriptionPreference();
  const languages = React.useMemo(
    () => transcriptionLanguageOptions(i18n.language),
    [i18n.language]
  );
  const language = activeLanguage ?? spoken?.language;
  const spokenName = languages.find(l => l.code === language)?.name;

  const pickLanguage = (language: TranscriptionLanguage) => {
    setLanguageOpen(false);
    void spoken
      ?.setLanguage(language)
      .then(() => onChangeLanguage?.(language))
      .catch(() => {});
  };

  return (
    // Two adjacent controls, one group: the language button opens only the language picker, the
    // gear opens the rest (input + all audio settings).
    <ButtonGroup className="shrink-0 rounded-lg border border-dock-line">
      {spoken ? (
        <Popover open={languageOpen} onOpenChange={setLanguageOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={t('recording.panel.languageChip', { language: spokenName ?? '' })}
                  data-testid="recording-language-chip"
                  className="flex h-7 max-w-[10rem] cursor-pointer items-center gap-1 rounded-lg px-2 text-[12px] text-dock-ink-2 transition-colors hover:bg-dock-hover hover:text-dock-ink disabled:cursor-default disabled:opacity-50"
                  disabled={spoken.isPending && !spokenName}
                >
                  <span className="truncate">{spokenName ?? '…'}</span>
                  <ChevronDown className="size-3 shrink-0 opacity-60" />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">{t('recording.panel.language')}</TooltipContent>
          </Tooltip>
          <PopoverContent
            side="top"
            align="end"
            sideOffset={6}
            className={`w-[240px] p-0 ${DOCK_MENU_SURFACE}`}
          >
            <Command>
              <CommandInput placeholder={t('settings.transcription.language.search')} />
              <CommandList>
                <CommandEmpty>{t('settings.transcription.language.empty')}</CommandEmpty>
                <CommandGroup>
                  {languages.map(lang => (
                    <CommandItem
                      key={lang.code}
                      value={lang.name}
                      keywords={[lang.code]}
                      onSelect={() => pickLanguage(lang.code)}
                      className="flex items-center gap-2 text-[12.5px]"
                    >
                      <Check
                        className={`size-3.5 shrink-0 ${
                          language === lang.code ? 'opacity-100' : 'opacity-0'
                        }`}
                      />
                      <span className="flex-1 truncate">{lang.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      ) : null}
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={DOCK_CTL}
                aria-label={t('recording.panel.soundSettings')}
              >
                <Settings className="size-[15px]" />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{t('recording.panel.soundSettings')}</TooltipContent>
        </Tooltip>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={6}
          className={`w-[260px] ${DOCK_MENU_SURFACE}`}
        >
          <div className="px-2 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wide text-dock-ink-3">
            {t('recording.panel.input')}
          </div>
          {devices.map(device => (
            <button
              key={device.deviceId}
              type="button"
              onClick={() => {
                // Promote the pick to the head of the chain — System default included —
                // preserving the rest as fallbacks (same semantics as the transcription
                // settings screen).
                setPreferences({
                  microphonePriority: promoteMicrophone(preferences.microphonePriority, device),
                });
                setOpen(false);
              }}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-dock-ink transition-colors hover:bg-dock-hover"
            >
              <Mic className="size-[13px] shrink-0 text-dock-ink-2" />
              <span className="min-w-0 flex-1 truncate">{device.label}</span>
              <Check
                className={`size-3.5 shrink-0 text-success ${
                  device.deviceId === activeId ? 'visible' : 'invisible'
                }`}
              />
            </button>
          ))}
          {/* Footer: the note left, the full-settings jump as a small gear icon
            right — as a row it read as another selectable input (user
            feedback), mirroring the model picker's footer language instead. */}
          <div className="mt-1 flex items-center gap-2 border-t border-dock-line py-1 pl-2 pr-1">
            <span className="min-w-0 flex-1 truncate text-2xs text-dock-ink-3">
              {t('recording.panel.systemAudioCaptured')}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    router.push('/settings/transcription');
                  }}
                  aria-label={t('recording.panel.allAudioSettings')}
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-dock-ink-3 transition-colors hover:bg-dock-hover hover:text-dock-ink"
                >
                  <Settings className="size-[13px]" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('recording.panel.allAudioSettings')}</TooltipContent>
            </Tooltip>
          </div>
        </PopoverContent>
      </Popover>
    </ButtonGroup>
  );
}
