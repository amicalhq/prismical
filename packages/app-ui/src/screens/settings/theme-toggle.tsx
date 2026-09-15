'use client';

import { useAccountExperience } from '@prismical/app-client';
import { Sun, Moon, Monitor } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '../../ui/tabs';
import { useTranslation } from 'react-i18next';

export function ThemeToggle() {
  const { t } = useTranslation();
  const { data, update } = useAccountExperience();
  const theme = data?.experience.theme ?? 'system';
  function handleChange(value: string) {
    if (value === 'light' || value === 'dark' || value === 'system')
      update?.({ experience: { theme: value } });
  }

  return (
    <Tabs value={theme} onValueChange={handleChange}>
      <TabsList>
        <TabsTrigger
          disabled={!data}
          value="light"
          aria-label={t('settings.preferences.theme.light')}
        >
          <Sun className="size-4" />
        </TabsTrigger>
        <TabsTrigger
          disabled={!data}
          value="system"
          aria-label={t('settings.preferences.theme.system')}
        >
          <Monitor className="size-4" />
        </TabsTrigger>
        <TabsTrigger
          disabled={!data}
          value="dark"
          aria-label={t('settings.preferences.theme.dark')}
        >
          <Moon className="size-4" />
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
