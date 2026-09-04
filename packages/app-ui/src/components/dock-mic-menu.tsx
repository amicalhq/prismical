'use client';

import * as React from 'react';
import { Check, Mic, Settings } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import {
  promoteMicrophone,
  resolveActiveMicrophone,
  useMicrophoneDevices,
  useNavigation,
  useRecordingPreferences,
} from '@prismical/app-client';
import { DOCK_CTL, DOCK_MENU_SURFACE } from './dock-chrome';
import { useTranslation } from 'react-i18next';

/**
 * The record panel's input/sound menu: a gear control in the panel's
 * bottom bar that lists the connected microphones (pick = promote to the top
 * of the priority chain, same semantics as the transcription settings screen)
 * plus a jump to the full audio settings. Devices enumerate only while the
 * menu is open — no standing device subscription for a closed menu.
 */
export function DockMicMenu() {
  const { t } = useTranslation();
  const router = useNavigation();
  const [open, setOpen] = React.useState(false);
  const devices = useMicrophoneDevices(open);
  const [preferences, setPreferences] = useRecordingPreferences();
  const activeId = resolveActiveMicrophone(preferences.microphonePriority, devices);

  return (
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
  );
}
