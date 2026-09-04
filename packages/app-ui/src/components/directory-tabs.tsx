'use client';

import { AppLink as Link } from '../shell/app-link';
import { usePathname } from '@prismical/app-client';
import { cn } from '../lib/utils';
import { useTranslation } from 'react-i18next';

// The single [People | Companies] toggle shown at the top of both directory list views
// provides one sidebar entry for two peer views.
export function DirectoryTabs() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const onCompanies = pathname.startsWith('/companies');

  const tab = (href: string, label: string, active: boolean) => (
    <Link
      href={href}
      className={cn(
        'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {label}
    </Link>
  );

  return (
    <div className="inline-flex rounded-lg bg-muted p-0.5">
      {tab('/people', t('directory.people.title'), !onCompanies)}
      {tab('/companies', t('directory.companies.title'), onCompanies)}
    </div>
  );
}
