'use client';

import * as React from 'react';
import { useTranslation } from 'react-i18next';

export interface RecordingPreferences {
  autoTranscribeNewNotes: boolean;
  /** Legacy device-local language pick. Read once to seed the account preference; not written. */
  autoDetectLanguage: boolean;
  /** Legacy device-local language pick (see above). The account preference is the source now. */
  language: string;
  /** Ordered device fallback chain, highest priority first. */
  microphonePriority: MicrophonePriorityEntry[];
}

export interface MicrophoneDevice {
  deviceId: string;
  label: string;
  isDefault?: boolean;
}

export interface MicrophonePriorityEntry {
  deviceId: string;
  name: string;
}

const STORAGE_KEY = 'prismical:recording-preferences:v1';
const PENDING_AUTO_TRANSCRIBE_KEY = 'prismical:pending-auto-transcribe-note';
export const DEFAULT_MICROPHONE_DEVICE_ID = 'default';

export const DEFAULT_RECORDING_PREFERENCES: RecordingPreferences = {
  autoTranscribeNewNotes: false,
  autoDetectLanguage: true,
  language: 'en',
  microphonePriority: [],
};

function normalizeMicrophonePriority(value: unknown): MicrophonePriorityEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const candidate = entry as Partial<MicrophonePriorityEntry>;
    if (
      typeof candidate.deviceId !== 'string' ||
      !candidate.deviceId ||
      seen.has(candidate.deviceId)
    ) {
      return [];
    }
    seen.add(candidate.deviceId);
    return [
      {
        deviceId: candidate.deviceId,
        name:
          typeof candidate.name === 'string' && candidate.name
            ? candidate.name
            : candidate.deviceId,
      },
    ];
  });
}

function normalize(value: unknown): RecordingPreferences {
  if (!value || typeof value !== 'object') return DEFAULT_RECORDING_PREFERENCES;
  const candidate = value as Partial<RecordingPreferences>;
  return {
    autoTranscribeNewNotes:
      typeof candidate.autoTranscribeNewNotes === 'boolean'
        ? candidate.autoTranscribeNewNotes
        : DEFAULT_RECORDING_PREFERENCES.autoTranscribeNewNotes,
    autoDetectLanguage:
      typeof candidate.autoDetectLanguage === 'boolean'
        ? candidate.autoDetectLanguage
        : DEFAULT_RECORDING_PREFERENCES.autoDetectLanguage,
    language:
      typeof candidate.language === 'string' && candidate.language.length > 0
        ? candidate.language
        : DEFAULT_RECORDING_PREFERENCES.language,
    microphonePriority: normalizeMicrophonePriority(candidate.microphonePriority),
  };
}

/** Device-local web recording preferences. SSR-safe and tolerant of blocked storage. */
export function getRecordingPreferences(): RecordingPreferences {
  if (typeof window === 'undefined') return DEFAULT_RECORDING_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalize(JSON.parse(raw)) : DEFAULT_RECORDING_PREFERENCES;
  } catch {
    return DEFAULT_RECORDING_PREFERENCES;
  }
}

/** Persist a partial update and notify same-tab listeners. */
export function setRecordingPreferences(
  patch: Partial<RecordingPreferences>
): RecordingPreferences {
  const next = normalize({ ...getRecordingPreferences(), ...patch });
  if (typeof window === 'undefined') return next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    if (!next.autoTranscribeNewNotes) {
      window.sessionStorage.removeItem(PENDING_AUTO_TRANSCRIBE_KEY);
    }
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
  } catch {
    // The current tab still receives `next`; persistence is best-effort when a
    // browser disables storage (private mode or policy).
  }
  return next;
}

export function useRecordingPreferences(): [
  RecordingPreferences,
  (patch: Partial<RecordingPreferences>) => void,
] {
  const [preferences, setPreferences] = React.useState(DEFAULT_RECORDING_PREFERENCES);

  React.useEffect(() => {
    setPreferences(getRecordingPreferences());
    const sync = (event: StorageEvent) => {
      if (event.key === null || event.key === STORAGE_KEY) {
        setPreferences(getRecordingPreferences());
      }
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  const set = React.useCallback((patch: Partial<RecordingPreferences>) => {
    setPreferences(setRecordingPreferences(patch));
  }, []);

  return [preferences, set];
}

export function findConnectedMicrophone<T extends { deviceId: string }>(
  entry: MicrophonePriorityEntry,
  connected: T[]
): T | undefined {
  return connected.find(device => device.deviceId === entry.deviceId);
}

/** Resolve the first currently connected microphone, with system default as the fallback. */
export function resolveActiveMicrophone(
  priority: MicrophonePriorityEntry[],
  connected: MicrophoneDevice[]
): string {
  for (const entry of priority) {
    if (findConnectedMicrophone(entry, connected)) return entry.deviceId;
  }
  return DEFAULT_MICROPHONE_DEVICE_ID;
}

/** Preserve known ordering and append microphones that were connected for the first time. */
export function mergeConnectedMicrophones(
  priority: MicrophonePriorityEntry[],
  connected: MicrophoneDevice[]
): MicrophonePriorityEntry[] {
  const known = new Set(priority.map(entry => entry.deviceId));
  return [
    ...priority,
    ...connected
      .filter(device => !known.has(device.deviceId))
      .map(device => ({ deviceId: device.deviceId, name: device.label })),
  ];
}

/** Promote a chosen microphone while retaining the previous devices as fallbacks. */
export function promoteMicrophone(
  priority: MicrophonePriorityEntry[],
  chosen: MicrophoneDevice
): MicrophonePriorityEntry[] {
  return [
    { deviceId: chosen.deviceId, name: chosen.label },
    ...priority.filter(entry => entry.deviceId !== chosen.deviceId),
  ];
}

/** Mark the newly created note that should start recording after navigation + server ack. */
export function markPendingAutoTranscribe(noteId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(PENDING_AUTO_TRANSCRIBE_KEY, noteId);
  } catch {
    // Auto-start is a convenience; note creation must still succeed without storage.
  }
}

/** One-shot consume. A marker for another note remains available for its own route. */
export function consumePendingAutoTranscribe(noteId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.sessionStorage.getItem(PENDING_AUTO_TRANSCRIBE_KEY) !== noteId) {
      return false;
    }
    window.sessionStorage.removeItem(PENDING_AUTO_TRANSCRIBE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Enumerate real browser microphones and refresh when devices change. */
export function useMicrophoneDevices(enabled = true): MicrophoneDevice[] {
  const { t } = useTranslation();
  const [devices, setDevices] = React.useState<MicrophoneDevice[]>([]);

  React.useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!enabled || !mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const seen = new Set<string>();
        const inputs = (await mediaDevices.enumerateDevices())
          .filter(device => device.kind === 'audioinput' && device.deviceId)
          .filter(device => {
            if (
              device.deviceId === DEFAULT_MICROPHONE_DEVICE_ID ||
              device.deviceId === 'communications' ||
              seen.has(device.deviceId)
            ) {
              return false;
            }
            seen.add(device.deviceId);
            return true;
          })
          .map((device, index) => ({
            deviceId: device.deviceId,
            label:
              device.label || t('settings.transcription.microphoneNumber', { number: index + 1 }),
          }));
        if (cancelled) return;
        setDevices([
          {
            deviceId: DEFAULT_MICROPHONE_DEVICE_ID,
            label: t('settings.transcription.systemDefault'),
            isDefault: true,
          },
          ...inputs,
        ]);
      } catch {
        if (!cancelled) {
          setDevices([
            {
              deviceId: DEFAULT_MICROPHONE_DEVICE_ID,
              label: t('settings.transcription.systemDefault'),
              isDefault: true,
            },
          ]);
        }
      }
    };
    void refresh();
    mediaDevices.addEventListener?.('devicechange', refresh);
    return () => {
      cancelled = true;
      mediaDevices.removeEventListener?.('devicechange', refresh);
    };
  }, [enabled, t]);

  return devices;
}
