'use client';

import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '../../ui/tabs';
import { useTranslation } from 'react-i18next';

type Theme = 'light' | 'dark' | 'system';

function applyTheme(theme: Theme) {
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', isDark);
}

export function ThemeToggle() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    const stored = localStorage.getItem('theme') as Theme | null;
    const initial: Theme =
      stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
    setTheme(initial);
    applyTheme(initial);
  }, []);

  // Re-apply when system color scheme changes (only relevant in "system" mode)
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  function handleChange(value: string) {
    const next = value as Theme;
    setTheme(next);
    localStorage.setItem('theme', next);
    applyTheme(next);
  }

  return (
    <Tabs value={theme} onValueChange={handleChange}>
      <TabsList>
        <TabsTrigger value="light" aria-label={t('settings.preferences.theme.light')}>
          <Sun className="size-4" />
        </TabsTrigger>
        <TabsTrigger value="system" aria-label={t('settings.preferences.theme.system')}>
          <Monitor className="size-4" />
        </TabsTrigger>
        <TabsTrigger value="dark" aria-label={t('settings.preferences.theme.dark')}>
          <Moon className="size-4" />
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
