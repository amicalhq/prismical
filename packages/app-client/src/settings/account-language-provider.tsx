'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  UserPreferencesSchema,
  type LanguagePreferences,
  type UserPreferences,
} from '@prismical/api-contracts/apps/v1';
import {
  useApplicationLocale,
  ApplicationLocaleOverride,
  resolveLocale,
} from '@prismical/app-i18n';
import { ApiError, apiClient, ME_PREFIX } from '../api/client';
import { useActiveSessionKey, useSessionView } from '../ports-context';

const path = `${ME_PREFIX}/preferences`;
/** The `language` group of the account preferences resource; it is non-null once initialized. */
function languageGroup(response: unknown): LanguagePreferences {
  const { language } = UserPreferencesSchema.parse(response) satisfies UserPreferences;
  if (!language) throw new Error('Account language preferences are not initialized');
  return language;
}
interface AccountLanguageValue {
  preferences?: LanguagePreferences;
  isPending: boolean;
  error: boolean;
  update: (patch: Partial<LanguagePreferences>) => Promise<void>;
  retry: () => void;
}
const Context = createContext<AccountLanguageValue | null>(null);
export const useAccountLanguage = () => useContext(Context);

export function AccountLanguageProvider({ children }: { children: ReactNode }) {
  const locale = useApplicationLocale();
  const sessionKey = useActiveSessionKey();
  const session = useSessionView();
  const client = useQueryClient();
  const identity = useRef(sessionKey);
  identity.current = sessionKey;
  const key = ['account-language', sessionKey];
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
      // Read first; the periodic refetch must not write. Only an account that never initialized
      // the group on any device seeds it from this device's locale (write-once on the server).
      const saved = UserPreferencesSchema.parse(
        await apiClient.getRaw(path, undefined, { activeOrgId: null })
      ).language;
      if (identity.current !== sessionKey) throw new Error('The active account changed');
      if (saved) return saved;
      return languageGroup(
        await apiClient.postRaw(
          path,
          { language: { interfaceLanguage: resolveLocale('system', locale.systemLocale) } },
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
      patch: Partial<LanguagePreferences>;
      owner: string | null;
    }) => {
      if (!owner || identity.current !== owner) throw new Error('The active account changed');
      return languageGroup(
        await apiClient.patchRaw(path, { language: patch }, { activeOrgId: null })
      );
    },
    onMutate: async ({ owner }) => {
      await client.cancelQueries({ queryKey: ['account-language', owner] });
    },
    onSuccess: (data, { owner }) => client.setQueryData(['account-language', owner], data),
  });
  const [saveFailed, setSaveFailed] = useState(false);
  useEffect(() => {
    setSaveFailed(false);
  }, [sessionKey]);
  const update = async (patch: Partial<LanguagePreferences>) => {
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
  // picker keeps working device-locally (its pre-account behaviour); only the AI-output row shows
  // the error and its retry.
  const loadFailed = query.isError && !saved;
  const { preference: devicePreference, changePreference: applyLocale } = locale;
  const appliedAccount = useRef(sessionKey);
  // Applying a saved account choice only updates the device cache. It must not write it back
  // to the account, or switching devices would turn a read into an accidental preference edit.
  useEffect(() => {
    if (
      !saved ||
      identity.current !== sessionKey ||
      (saved.interfaceLanguage === devicePreference && appliedAccount.current === sessionKey)
    )
      return;
    appliedAccount.current = sessionKey;
    void applyLocale(saved.interfaceLanguage);
  }, [saved, devicePreference, applyLocale, sessionKey]);

  return (
    <Context.Provider
      value={{
        preferences: saved,
        isPending: !saved || mutation.isPending,
        error: query.isError || saveFailed,
        update,
        retry: () => {
          setSaveFailed(false);
          void query.refetch();
        },
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
              : (saved?.interfaceLanguage ?? locale.preference),
          isSaving: locale.isSaving || (!saved && !loadFailed) || mutation.isPending,
          changePreference: loadFailed
            ? locale.changePreference
            : async next => {
                const interfaceLanguage = resolveLocale(next, locale.systemLocale);
                if (interfaceLanguage === saved?.interfaceLanguage) {
                  if (interfaceLanguage !== devicePreference) await applyLocale(interfaceLanguage);
                  return;
                }
                try {
                  await update({ interfaceLanguage });
                } catch {
                  // The settings row renders the failure and leaves the saved value selected.
                }
              },
        }}
      >
        {children}
      </ApplicationLocaleOverride>
    </Context.Provider>
  );
}
