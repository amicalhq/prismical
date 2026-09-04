'use client';

import { AppLink as Link } from '../shell/app-link';
import { ArrowLeft, Users } from 'lucide-react';
import { useCompany } from '@prismical/app-client';
import { CompanyAvatar, PersonAvatar } from '../components/directory-avatars';
import {
  DirectoryListSkeleton,
  DirectoryError,
  DirectoryEmpty,
} from '../components/directory-states';
import { Badge } from '../ui/badge';
import { personDisplayName } from '../lib/people-display';
import { formatApplicationLastMet, useApplicationLocale } from '@prismical/app-i18n';
import { useTranslation } from 'react-i18next';

// Company detail screen. The Next route param is unwrapped by the thin
// web wrapper and handed in as `id`, so the screen stays framework-free.
export function CompanyDetailScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const { data, isLoading, error } = useCompany(id);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Link
        href="/companies"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> {t('directory.companies.title')}
      </Link>

      {isLoading ? (
        <DirectoryListSkeleton />
      ) : error ? (
        <DirectoryError />
      ) : !data ? null : (
        <>
          <div className="mb-6 flex items-center gap-4">
            <CompanyAvatar company={data.company} className="size-14 rounded-lg text-lg" />
            <div className="min-w-0">
              <h1 className="truncate text-xl font-bold">{data.company.name}</h1>
              <p className="truncate text-sm text-muted-foreground">{data.company.domain}</p>
            </div>
          </div>

          <h2 className="mb-2 text-sm font-medium text-muted-foreground">
            {t('directory.companies.peopleMet')}
          </h2>
          {data.people.length === 0 ? (
            <DirectoryEmpty icon={Users} title={t('directory.people.noCompanyPeople')} />
          ) : (
            <div className="overflow-hidden rounded-xl bg-muted">
              {data.people.map(p => (
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
                    <p className="truncate text-xs text-muted-foreground">{p.email}</p>
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
        </>
      )}
    </div>
  );
}
