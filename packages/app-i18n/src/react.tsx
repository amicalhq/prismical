'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { i18n } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import {
  defaultLocale,
  matchSupportedLocale,
  resolveLocale,
  type LocalePreference,
  type SupportedLocale,
} from './locale';

export type LocaleApplyMode = 'immediate' | 'restart';

export interface ApplicationLocaleContextValue {
  readonly preference: LocalePreference;
  readonly resolvedLocale: SupportedLocale;
  readonly applyMode: LocaleApplyMode;
  readonly restartRequired: boolean;
  readonly isSaving: boolean;
  readonly changePreference: (next: LocalePreference) => Promise<void>;
  readonly restartApplication: (() => Promise<void>) | null;
}

export interface ApplicationI18nProviderProps {
  readonly children?: ReactNode;
  readonly instance: i18n;
  readonly initialPreference: LocalePreference;
  readonly systemLocale?: string | null;
  readonly applyMode: LocaleApplyMode;
  readonly persistPreference: (next: LocalePreference) => Promise<void> | void;
  readonly restartApplication?: () => Promise<void>;
  readonly onPersistenceError?: (error: unknown) => void;
  readonly onAppliedLocale?: (locale: SupportedLocale) => void;
}

const ApplicationLocaleContext = createContext<ApplicationLocaleContextValue | null>(null);

function instanceLocale(instance: i18n): SupportedLocale {
  return matchSupportedLocale(instance.resolvedLanguage ?? instance.language) ?? defaultLocale;
}

export function ApplicationI18nProvider({
  children,
  instance,
  initialPreference,
  systemLocale,
  applyMode,
  persistPreference,
  restartApplication,
  onPersistenceError,
  onAppliedLocale,
}: ApplicationI18nProviderProps) {
  const [preference, setPreference] = useState<LocalePreference>(initialPreference);
  const [resolvedLocale, setResolvedLocale] = useState<SupportedLocale>(() =>
    instanceLocale(instance)
  );
  const [restartRequired, setRestartRequired] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const startupLocale = useRef(instanceLocale(instance));

  useEffect(() => {
    setPreference(initialPreference);
  }, [initialPreference]);

  useEffect(() => {
    const handleLanguageChanged = (language: string) => {
      const next = matchSupportedLocale(language) ?? defaultLocale;
      setResolvedLocale(next);
      onAppliedLocale?.(next);
    };
    instance.on('languageChanged', handleLanguageChanged);
    onAppliedLocale?.(instanceLocale(instance));
    return () => {
      instance.off('languageChanged', handleLanguageChanged);
    };
  }, [instance, onAppliedLocale]);

  const changePreference = useCallback(
    async (next: LocalePreference): Promise<void> => {
      const nextResolvedLocale = resolveLocale(next, systemLocale);
      setIsSaving(true);

      if (applyMode === 'immediate') {
        await instance.changeLanguage(nextResolvedLocale);
        setPreference(next);
        setRestartRequired(false);
        try {
          await persistPreference(next);
        } catch (error) {
          onPersistenceError?.(error);
        } finally {
          setIsSaving(false);
        }
        return;
      }

      try {
        await persistPreference(next);
        setPreference(next);
        setRestartRequired(nextResolvedLocale !== startupLocale.current);
      } catch (error) {
        onPersistenceError?.(error);
      } finally {
        setIsSaving(false);
      }
    },
    [applyMode, instance, onPersistenceError, persistPreference, systemLocale]
  );

  const value = useMemo<ApplicationLocaleContextValue>(
    () => ({
      preference,
      resolvedLocale,
      applyMode,
      restartRequired,
      isSaving,
      changePreference,
      restartApplication: restartApplication ?? null,
    }),
    [
      applyMode,
      changePreference,
      isSaving,
      preference,
      resolvedLocale,
      restartApplication,
      restartRequired,
    ]
  );

  return (
    <I18nextProvider i18n={instance}>
      <ApplicationLocaleContext.Provider value={value}>
        {children}
      </ApplicationLocaleContext.Provider>
    </I18nextProvider>
  );
}

export function useApplicationLocale(): ApplicationLocaleContextValue {
  const context = useContext(ApplicationLocaleContext);
  if (context === null) {
    throw new Error('useApplicationLocale must be used inside ApplicationI18nProvider');
  }
  return context;
}
