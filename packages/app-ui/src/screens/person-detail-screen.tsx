'use client';

import { AppLink as Link } from '../shell/app-link';
import { ArrowLeft, AudioLines, CalendarDays, FileText } from 'lucide-react';
import { usePerson } from '@prismical/app-client';
import { PersonAvatar } from '../components/directory-avatars';
import {
  DirectoryListSkeleton,
  DirectoryError,
  DirectoryEmpty,
} from '../components/directory-states';
import { Badge } from '../ui/badge';
import { personDisplayName } from '../lib/people-display';
import { formatApplicationDateLabel, useApplicationLocale } from '@prismical/app-i18n';
import { useTranslation } from 'react-i18next';

// Person detail screen. The Next route param is unwrapped by the thin web
// wrapper and handed in as `id`, so the screen stays framework-free.
export function PersonDetailScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const { data, isLoading, error } = usePerson(id);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Link
        href="/people"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> {t('directory.people.title')}
      </Link>

      {isLoading ? (
        <DirectoryListSkeleton />
      ) : error ? (
        <DirectoryError />
      ) : !data ? null : (
        <>
          <div className="mb-6 flex items-center gap-4">
            <PersonAvatar person={data.person} className="size-14 text-lg" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-xl font-bold">{personDisplayName(data.person)}</h1>
                {data.person.isInternal ? (
                  <Badge variant="secondary" className="text-2xs">
                    {t('directory.people.team')}
                  </Badge>
                ) : null}
              </div>
              <p className="truncate text-sm text-muted-foreground">{data.person.email}</p>
              {data.person.company ? (
                <Link
                  href={`/companies/${data.person.company.id}`}
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground hover:underline"
                >
                  {data.person.company.name}
                </Link>
              ) : null}
            </div>
          </div>

          <h2 className="mb-2 text-sm font-medium text-muted-foreground">
            {t('directory.people.meetingHistory')}
          </h2>
          {data.meetings.length === 0 ? (
            <DirectoryEmpty icon={CalendarDays} title={t('directory.people.noMeetings')} />
          ) : (
            <div className="overflow-hidden rounded-xl bg-muted">
              {data.meetings.map(m => (
                <div key={m.eventId} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{m.title}</p>
                      {m.responseStatus === 'declined' ? (
                        <Badge variant="outline" className="text-2xs text-muted-foreground">
                          {t('directory.people.declined')}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {m.startsAt
                        ? formatApplicationDateLabel(
                            new Date(m.startsAt),
                            new Date(),
                            resolvedLocale,
                            t
                          )
                        : '—'}
                      {m.role === 'organizer' ? ` · ${t('directory.people.organizer')}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {m.recordingCount > 0 ? (
                      <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
                        <AudioLines className="size-3" /> {m.recordingCount}
                      </span>
                    ) : null}
                    {m.noteId ? (
                      <Link
                        href={`/notes/${m.noteId}`}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
                      >
                        <FileText className="size-3.5" /> {t('directory.people.note')}
                      </Link>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
