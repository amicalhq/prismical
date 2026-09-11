'use client';

import { ArrowUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTranscriptionPreference } from '@prismical/app-client';
import { AppLink } from '../../shell/app-link';
import { Button } from '../../ui/button';
import { Label } from '../../ui/label';
import { Separator } from '../../ui/separator';
import { transcriptionLanguageName } from '../../lib/transcription-language-name';

/**
 * The spoken language sits with the other language preferences, but it is ONE setting whose
 * control lives in Settings > Transcription (and in the recording panel). This row shows the
 * current value and hands off there, so the setting has one home and would surface once in a
 * settings search.
 */
export function SpokenLanguageLink() {
  const { t, i18n } = useTranslation();
  const spoken = useTranscriptionPreference();

  const language = spoken?.language
    ? transcriptionLanguageName(spoken.language, i18n.language)
    : undefined;

  return (
    <>
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0 space-y-1">
          <Label className="text-base font-medium text-foreground">
            {t('settings.transcription.language.label')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.preferences.spokenLanguage.description')}
            {language ? ` ${t('settings.preferences.spokenLanguage.current', { language })}` : null}
          </p>
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <AppLink href="/settings/transcription">
            {t('settings.preferences.spokenLanguage.open')}
            <ArrowUpRight aria-hidden="true" />
          </AppLink>
        </Button>
      </div>

      <Separator />
    </>
  );
}
