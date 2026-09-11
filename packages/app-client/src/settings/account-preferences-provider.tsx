'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  LANGUAGE_PREFERENCE_DEFAULTS,
  TRANSCRIPTION_PREFERENCE_DEFAULTS,
  UserPreferencesSchema,
  type LanguagePreferences,
  type TranscriptionLanguage,
  type TranscriptionPreferences,
  type UpdateUserPreferencesRequest,
  type UserPreferences,
} from '@prismical/api-contracts/apps/v1';
import {
  useApplicationLocale,
  ApplicationLocaleOverride,
  resolveLocale,
} from '@prismical/app-i18n';
import { ApiError, apiClient, ME_PREFIX } from '../api/client';
import { useActiveSessionKey, useSessionView } from '../ports-context';
import { getRecordingPreferences } from '../recording/recording-preferences';
import {
  clearTranscriptionLanguage,
  guessTranscriptionLanguage,
  markTranscriptionLanguageLoading,
  publishTranscriptionLanguage,
} from './transcription-language';

const path = `${ME_PREFIX}/preferences`;

/**
 * Every group present. The server seeds what a device proposes, so after a POST none is null —
 * except a stored group that no longer parses (a value this client's schema dropped), which the
 * server reads as null and will not reseed. That must not take the whole settings page down:
 * such a group reads as its defaults, and the next save repairs it.
 */
type Initialized = { language: LanguagePreferences; transcription: TranscriptionPreferences };
function initialized(response: unknown): Initialized {
  const { language, transcription } = UserPreferencesSchema.parse(
    response
  ) satisfies UserPreferences;
  return {
    language: language ?? LANGUAGE_PREFERENCE_DEFAULTS,
    transcription: transcription ?? TRANSCRIPTION_PREFERENCE_DEFAULTS,
  };
}

interface AccountLanguageValue {
  preferences?: LanguagePreferences;
  isPending: boolean;
  error: boolean;
  update: (patch: Partial<LanguagePreferences>) => Promise<void>;
  retry: () => void;
}
interface TranscriptionPreferenceValue {
  /** The account's spoken language; undefined until the account has answered. */
  language?: TranscriptionLanguage;
  isPending: boolean;
  error: boolean;
  setLanguage: (language: TranscriptionLanguage) => Promise<void>;
  retry: () => void;
}
const LanguageContext = createContext<AccountLanguageValue | null>(null);
const TranscriptionContext = createContext<TranscriptionPreferenceValue | null>(null);
export const useAccountLanguage = () => useContext(LanguageContext);
export const useTranscriptionPreference = () => useContext(TranscriptionContext);

/**
 * Account preferences (`/me/preferences`) for the signed-in account: one query holding every
 * group, seeded once from this device when the account never chose, and one mutation merging
 * fields per group. The interface language is also pushed into the locale override so the app
 * renders in the account's choice on every device.
 */
export function AccountPreferencesProvider({ children }: { children: ReactNode }) {
  const locale = useApplicationLocale();
  const sessionKey = useActiveSessionKey();
  const session = useSessionView();
  const client = useQueryClient();
  const identity = useRef(sessionKey);
  identity.current = sessionKey;
  const key = ['account-preferences', sessionKey];
  const enabled = locale.isReady && !!sessionKey && session.state === 'signed-in';
  const query = useQuery({
    queryKey: key,
    enabled,
    // Desktop can render before its local workspace finishes mounting.
    // Initialization is idempotent, so transient transport failures are safe to retry.
    retry: (count, error) =>
      count < 3 && error instanceof ApiError && (error.status === 0 || error.status >= 500),
    retryDelay: attempt => Math.min(500 * 2 ** attempt, 2_000),
    staleTime: 30_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      if (identity.current !== sessionKey) throw new Error('The active account changed');
      // Read first; the periodic refetch must not write. Only groups the account never
      // initialized on any device are seeded from this one (write-once on the server).
      const saved = UserPreferencesSchema.parse(
        await apiClient.getRaw(path, undefined, { activeOrgId: null })
      );
      if (identity.current !== sessionKey) throw new Error('The active account changed');
      if (saved.language && saved.transcription) {
        return { language: saved.language, transcription: saved.transcription };
      }
      return initialized(
        await apiClient.postRaw(
          path,
          {
            ...(saved.language
              ? {}
              : { language: { interfaceLanguage: resolveLocale('system', locale.systemLocale) } }),
            ...(saved.transcription
              ? {}
              : {
                  transcription: {
                    language: guessTranscriptionLanguage(
                      locale.systemLocale,
                      getRecordingPreferences()
                    ),
                  },
                }),
          },
          { activeOrgId: null }
        )
      );
    },
  });
  const mutation = useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: async ({
      patch,
      owner,
    }: {
      patch: UpdateUserPreferencesRequest;
      owner: string | null;
    }) => {
      if (!owner || identity.current !== owner) throw new Error('The active account changed');
      return initialized(await apiClient.patchRaw(path, patch, { activeOrgId: null }));
    },
    onMutate: async ({ owner }) => {
      await client.cancelQueries({ queryKey: ['account-preferences', owner] });
    },
    onSuccess: (data, { owner }) => client.setQueryData(['account-preferences', owner], data),
  });
  const [saveFailed, setSaveFailed] = useState(false);
  useEffect(() => {
    setSaveFailed(false);
  }, [sessionKey]);
  const save = async (patch: UpdateUserPreferencesRequest) => {
    setSaveFailed(false);
    try {
      await mutation.mutateAsync({ patch, owner: sessionKey });
    } catch (error) {
      if (identity.current === sessionKey) setSaveFailed(true);
      throw error;
    }
  };
  const saved = query.data;
  // A failed load must not lock the interface-language picker: until the account answers, that
  // picker keeps working device-locally (its pre-account behaviour); only the account rows show
  // the error and its retry.
  const loadFailed = query.isError && !saved;
  const { preference: devicePreference, changePreference: applyLocale } = locale;
  const appliedAccount = useRef(sessionKey);
  // Applying a saved account choice only updates the device cache. It must not write it back
  // to the account, or switching devices would turn a read into an accidental preference edit.
  useEffect(() => {
    const interfaceLanguage = saved?.language.interfaceLanguage;
    if (
      !interfaceLanguage ||
      identity.current !== sessionKey ||
      (interfaceLanguage === devicePreference && appliedAccount.current === sessionKey)
    )
      return;
    appliedAccount.current = sessionKey;
    void applyLocale(interfaceLanguage);
  }, [saved, devicePreference, applyLocale, sessionKey]);
  // The recording controllers read the spoken language outside React at create time: while the
  // account is being fetched they wait for it; without a signed-in account they guess.
  const spoken = saved?.transcription.language;
  const loadErrored = query.isError;
  useEffect(() => {
    if (!enabled) {
      clearTranscriptionLanguage();
      return;
    }
    if (spoken) publishTranscriptionLanguage(spoken);
    // An account that cannot be read (auth, outage) must not make every Record wait: guess.
    else if (loadErrored) clearTranscriptionLanguage();
    else markTranscriptionLanguageLoading();
    return () => clearTranscriptionLanguage();
  }, [enabled, spoken, loadErrored]);

  const retry = () => {
    setSaveFailed(false);
    void query.refetch();
  };
  const error = query.isError || saveFailed;
  return (
    <LanguageContext.Provider
      value={{
        preferences: saved?.language,
        isPending: !saved || mutation.isPending,
        error,
        update: patch => save({ language: patch }),
        retry,
      }}
    >
      <TranscriptionContext.Provider
        value={{
          language: spoken,
          isPending: !saved || mutation.isPending,
          error,
          setLanguage: language => save({ transcription: { language } }),
          retry,
        }}
      >
        <ApplicationLocaleOverride
          value={{
            ...locale,
            accountManaged: !loadFailed,
            // Desktop only selects a preference after its native write is verified.
            preference:
              locale.applyMode === 'restart' && !loadFailed
                ? resolveLocale(devicePreference, locale.systemLocale)
                : (saved?.language.interfaceLanguage ?? locale.preference),
            isSaving: locale.isSaving || (!saved && !loadFailed) || mutation.isPending,
            changePreference: loadFailed
              ? locale.changePreference
              : async next => {
                  const interfaceLanguage = resolveLocale(next, locale.systemLocale);
                  if (interfaceLanguage === saved?.language.interfaceLanguage) {
                    if (interfaceLanguage !== devicePreference)
                      await applyLocale(interfaceLanguage);
                    return;
                  }
                  try {
                    await save({ language: { interfaceLanguage } });
                  } catch {
                    // The settings row renders the failure and leaves the saved value selected.
                  }
                },
          }}
        >
          {children}
        </ApplicationLocaleOverride>
      </TranscriptionContext.Provider>
    </LanguageContext.Provider>
  );
}

/** Former name; the shell still mounts it under this one. */
export const AccountLanguageProvider = AccountPreferencesProvider;
