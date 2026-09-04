'use client';

import { AppLink as Link } from '../shell/app-link';
import { Button } from '../ui/button';
import { useTranslation } from 'react-i18next';

// 404 body. A calm,
// centered surface with a way back rather than a bare Next.js default. The Next
// not-found convention file stays a thin web wrapper; this body uses the
// shared AppLink (the web root layout mounts the ports provider around it).
export function NotFoundScreen() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-3 px-4 text-center">
      <span className="text-4xl">🧭</span>
      <div className="space-y-1">
        <p className="text-sm font-medium">{t('pages.notFound.title')}</p>
        <p className="text-xs text-muted-foreground">{t('pages.notFound.body')}</p>
      </div>
      <Button asChild size="sm">
        <Link href="/home">{t('pages.notFound.back')}</Link>
      </Button>
    </div>
  );
}
