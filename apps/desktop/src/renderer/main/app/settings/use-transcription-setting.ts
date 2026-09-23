import { createContext, createElement, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useDeviceSettings } from '@prismical/app-client';
import type { TranscriptionSetting } from '@prismical/app-contracts';

interface TranscriptionSettings {
  transcription: TranscriptionSetting;
  patch: (fields: Partial<TranscriptionSetting>) => void;
}

const TranscriptionSettingsContext = createContext<TranscriptionSettings | null>(null);

/** Keep one writer alive while navigating between AI Models and Local models. */
export function TranscriptionSettingsProvider({ children }: { children: ReactNode }) {
  const { settings, set } = useDeviceSettings();
  const latest = useRef(settings.transcription);
  const pending = useRef(0);
  const writes = useRef(Promise.resolve());

  useEffect(() => {
    if (pending.current === 0) latest.current = settings.transcription;
  }, [settings.transcription]);

  const patch = useCallback((fields: Partial<TranscriptionSetting>) => {
    const transcription = { ...latest.current, ...fields };
    latest.current = transcription;
    pending.current += 1;
    // The desktop settings adapter reports write failures and resolves, so later edits still run.
    writes.current = writes.current
      .then(() => set({ transcription }))
      .finally(() => { pending.current -= 1; });
  }, [set]);

  return createElement(TranscriptionSettingsContext.Provider, {
    value: { transcription: settings.transcription, patch },
  }, children);
}

export function useTranscriptionSetting(): TranscriptionSettings {
  const value = useContext(TranscriptionSettingsContext);
  if (!value) throw new Error('TranscriptionSettingsProvider is required');
  return value;
}
