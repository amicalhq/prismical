'use client';

import { useState, type ChangeEvent } from 'react';
import { useApplicationLocale, type LocalePreference } from '@prismical/app-i18n';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../ui/alert-dialog';
import { Label } from '../../ui/label';

const localeOptions = [
  ['system', 'common.locale.names.system'],
  ['en', 'common.locale.names.en'],
  ['de', 'common.locale.names.de'],
  ['es', 'common.locale.names.es'],
  ['ja', 'common.locale.names.ja'],
  ['zh-TW', 'common.locale.names.zhTW'],
] as const satisfies ReadonlyArray<readonly [LocalePreference, string]>;

export function InterfaceLanguageSetting() {
  const { t } = useTranslation();
  const { preference, applyMode, restartRequired, isSaving, changePreference, restartApplication } =
    useApplicationLocale();
  const [dismissedPreference, setDismissedPreference] = useState<LocalePreference | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const dialogOpen =
    applyMode === 'restart' && restartRequired && dismissedPreference !== preference;

  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    setDismissedPreference(null);
    void changePreference(event.target.value as LocalePreference);
  }

  async function handleRestart() {
    if (restartApplication === null) return;
    setIsRestarting(true);
    try {
      await restartApplication();
    } finally {
      setIsRestarting(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="interface-language" className="text-base font-medium text-foreground">
            {t('settings.preferences.language.label')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.preferences.language.description')}
          </p>
        </div>
        <select
          id="interface-language"
          className="h-9 max-w-52 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          value={preference}
          disabled={isSaving}
          onChange={handleChange}
        >
          {localeOptions.map(([value, labelKey]) => (
            <option key={value} value={value}>
              {t(labelKey as never)}
            </option>
          ))}
        </select>
      </div>

      <AlertDialog
        open={dialogOpen}
        onOpenChange={open => {
          if (!open) setDismissedPreference(preference);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.preferences.language.restart.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {restartApplication === null
                ? t('settings.preferences.language.restart.applyNextStart')
                : t('settings.preferences.language.restart.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.actions.later')}</AlertDialogCancel>
            {restartApplication !== null ? (
              <AlertDialogAction disabled={isRestarting} onClick={() => void handleRestart()}>
                {isRestarting
                  ? t('settings.preferences.language.restart.restarting')
                  : t('settings.preferences.language.restart.restartNow')}
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
