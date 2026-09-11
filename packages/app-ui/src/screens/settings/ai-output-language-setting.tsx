'use client';

import { useTranslation } from 'react-i18next';
import {
  OUTPUT_LANGUAGES,
  type LanguagePreferences,
  useAccountLanguage,
} from '@prismical/app-client';
import { Label } from '../../ui/label';
import { Button } from '../../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';

export function AiOutputLanguageSetting() {
  const { t } = useTranslation();
  const language = useAccountLanguage();
  const value = language?.preferences?.aiOutputLanguage ?? 'source';
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="ai-output-language" className="text-base font-medium text-foreground">
            {t('settings.preferences.aiOutputLanguage.label')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.preferences.aiOutputLanguage.description')}
          </p>
        </div>
        <Select
          value={value}
          disabled={!language || language.isPending}
          onValueChange={next => {
            void language
              ?.update({ aiOutputLanguage: next as LanguagePreferences['aiOutputLanguage'] })
              .catch(() => {});
          }}
        >
          <SelectTrigger id="ai-output-language" className="max-w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* The default explains itself where the choice is made, not in a footnote. */}
            <SelectItem
              value="source"
              description={t('settings.preferences.aiOutputLanguage.sameAsNoteHint')}
            >
              {t('settings.preferences.aiOutputLanguage.sameAsNote')}
            </SelectItem>
            {Object.entries(OUTPUT_LANGUAGES).map(([code, name]) => (
              <SelectItem key={code} value={code}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {language?.error && (
        <div role="alert" className="text-sm text-destructive">
          {t('settings.preferences.aiOutputLanguage.saveError')}
          <Button variant="ghost" size="sm" onClick={language.retry}>
            {t('settings.preferences.aiOutputLanguage.retry')}
          </Button>
        </div>
      )}
    </div>
  );
}
