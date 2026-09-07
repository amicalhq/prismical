'use client';

import * as React from 'react';
import { AppLink as Link } from '../shell/app-link';
import { Building2, Search } from 'lucide-react';
import { Input } from '../ui/input';
import { useCompanies } from '@prismical/app-client';
import { useDebouncedValue } from '../hooks/use-debounced-value';
import { CompanyAvatar } from '../components/directory-avatars';
import { DirectoryTabs } from '../components/directory-tabs';
import {
  DirectoryListSkeleton,
  DirectoryError,
  DirectoryEmpty,
  DirectoryLoadMore,
  directoryRowClass,
} from '../components/directory-states';
import { formatApplicationLastMet, useApplicationLocale } from '@prismical/app-i18n';
import { useTranslation } from 'react-i18next';

// Companies directory screen.
export function CompaniesScreen() {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const [search, setSearch] = React.useState('');
  const { data, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage, isFetching } = useCompanies({
    search: useDebouncedValue(search),
  });
  const companies = data ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">{t('directory.companies.title')}</h1>
        <DirectoryTabs />
      </div>

      <div className="relative mb-4 min-w-[200px]">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t('directory.companies.search')}
          className="pl-8"
        />
      </div>

      {isLoading ? (
        <DirectoryListSkeleton />
      ) : error && companies.length === 0 ? (
        <DirectoryError />
      ) : companies.length === 0 ? (
        <DirectoryEmpty
          icon={Building2}
          title={search ? t('directory.companies.noMatch') : t('directory.companies.empty')}
          hint={search ? undefined : t('directory.companies.emptyHint')}
        />
      ) : (
        <div>
          {companies.map(c => (
            <Link
              key={c.id}
              href={`/companies/${c.id}`}
              className={directoryRowClass}
            >
              <CompanyAvatar company={c} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{c.name}</p>
                <p className="truncate text-xs text-muted-foreground">{c.domain}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-xs text-muted-foreground">
                  {formatApplicationLastMet(c.lastMetAt, Date.now(), resolvedLocale, t)}
                </p>
                <p className="text-2xs text-muted-foreground">
                  {t('directory.counts.person', { count: c.peopleCount })} ·{' '}
                  {t('directory.counts.meeting', { count: c.meetingCount })}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
      {error && companies.length > 0 ? <DirectoryError /> : null}
      {companies.length > 0 ? (
        <DirectoryLoadMore
          // `hasNextPage` reads false while `keepPreviousData` is showing the previous search's rows
          // (the new key has no data yet), which would yank the footer away mid-scroll. Keep it while
          // a fetch is in flight so the control does not flicker out and back.
          hasMore={Boolean(hasNextPage) || isFetching}
          isLoading={isFetchingNextPage || isFetching}
          hasError={Boolean(error)}
          onLoadMore={() => void fetchNextPage()}
        />
      ) : null}
    </div>
  );
}
