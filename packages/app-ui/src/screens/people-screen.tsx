'use client';

import * as React from 'react';
import { AppLink as Link } from '../shell/app-link';
import { Search, Users } from 'lucide-react';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import { usePeople, type PeopleFilter } from '@prismical/app-client';
import { useDebouncedValue } from '../hooks/use-debounced-value';
import { PersonAvatar } from '../components/directory-avatars';
import { DirectoryTabs } from '../components/directory-tabs';
import {
  DirectoryListSkeleton,
  DirectoryError,
  DirectoryEmpty,
} from '../components/directory-states';
import { personDisplayName } from '../lib/people-display';
import { cn } from '../lib/utils';
import { formatApplicationLastMet, useApplicationLocale } from '@prismical/app-i18n';
import { useTranslation } from 'react-i18next';

// People directory screen: search + external/team filter, then the directory list.

const FILTERS: PeopleFilter[] = ['all', 'external', 'internal'];

export function PeopleScreen() {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState<PeopleFilter>('all');
  const { data, isLoading, error } = usePeople({ search: useDebouncedValue(search), filter });
  const people = data?.people ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">{t('directory.people.title')}</h1>
        <DirectoryTabs />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('directory.people.search')}
            className="pl-8"
          />
        </div>
        <div className="inline-flex rounded-lg bg-muted p-0.5">
          {FILTERS.map(filterOption => (
            <button
              key={filterOption}
              type="button"
              onClick={() => setFilter(filterOption)}
              className={cn(
                'cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                filter === filterOption
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {filterOption === 'all'
                ? t('directory.people.all')
                : filterOption === 'external'
                  ? t('directory.people.external')
                  : t('directory.people.team')}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <DirectoryListSkeleton />
      ) : error ? (
        <DirectoryError />
      ) : people.length === 0 ? (
        <DirectoryEmpty
          icon={Users}
          title={search ? t('directory.people.noMatch') : t('directory.people.empty')}
          hint={search ? undefined : t('directory.people.emptyHint')}
        />
      ) : (
        <div className="overflow-hidden rounded-xl bg-muted">
          {people.map(p => (
            <Link
              key={p.id}
              href={`/people/${p.id}`}
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent"
            >
              <PersonAvatar person={p} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium">{personDisplayName(p)}</p>
                  {p.isInternal ? (
                    <Badge variant="secondary" className="h-5 px-1.5 text-2xs">
                      {t('directory.people.team')}
                    </Badge>
                  ) : null}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {p.company ? p.company.name : p.email}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-xs text-muted-foreground">
                  {formatApplicationLastMet(p.lastMetAt, Date.now(), resolvedLocale, t)}
                </p>
                <p className="text-2xs text-muted-foreground">
                  {t('directory.counts.meeting', { count: p.meetingCount })}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
