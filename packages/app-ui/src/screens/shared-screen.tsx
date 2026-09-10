'use client';

import * as React from 'react';
import { AppLink as Link } from '../shell/app-link';
import { FileText, Users } from 'lucide-react';
import { Badge } from '../ui/badge';
import { ListRowsSkeleton } from '../components/skeletons';
import { useNotes } from '@prismical/app-client';
import { formatApplicationLastMet, useApplicationLocale } from '@prismical/app-i18n';
import { useTranslation } from 'react-i18next';

/**
 * "Shared with me": notes the caller can read but does not own. Derived from the
 * notes list's `isOwner` flag — no extra fetch. Where an accepted invite lands.
 */
export function SharedScreen() {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const { data: notes = [], isLoading } = useNotes();
  const shared = notes.filter(n => n.isOwner === false);

  return (
    <div className="mx-auto w-full" style={{ maxWidth: 'var(--content-width-browse)' }}>
      <div className="mb-8">
        <h1 className="text-xl font-bold">{t('shared.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('shared.description')}</p>
      </div>

      {isLoading ? (
        <ListRowsSkeleton />
      ) : shared.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border py-16 text-center">
          <Users className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">{t('shared.emptyTitle')}</p>
          <p className="max-w-xs text-xs text-muted-foreground">{t('shared.emptyDescription')}</p>
        </div>
      ) : (
        <div className="divide-y rounded-xl border">
          {shared.map(n => (
            <Link
              key={n.id}
              href={`/notes/${n.id}`}
              className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
                {n.emoji ? (
                  <span className="text-base leading-none">{n.emoji}</span>
                ) : (
                  <FileText className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{n.title || t('notes.untitled')}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t('shared.sharedBy', { name: n.sharedByName || t('shared.someone') })}
                </p>
              </div>
              <Badge variant="outline" className="shrink-0">
                {n.writable === false ? t('shared.viewer') : t('shared.editor')}
              </Badge>
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                {formatApplicationLastMet(n.updatedAt, Date.now(), resolvedLocale, t)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
