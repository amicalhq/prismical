'use client';

import * as React from 'react';
import { NoteEditor } from '../components/note-editor';
import { NoteDetailSkeleton } from '../components/skeletons';
import { useNote, useDesktopCapabilities } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

// Note detail screen. The Next route param is unwrapped by the thin
// web wrapper and handed in as `noteId`, so the screen stays framework-free.
export function NoteDetailScreen({ noteId }: { noteId: string }) {
  const { t } = useTranslation();
  const { data: note, isLoading, error } = useNote(noteId);
  const unreadable = !isLoading && (!!error || !note);
  // One URL per note: `/n/<id>` sends signed-in visitors here, but "signed in" and
  // "on this note's ACL" are different things. Someone who followed a published link without
  // access lands on a 404 for a note they ARE entitled to read — so hand them back to the public
  // page. `?public=1` stops that page from redirecting them straight back (the guard on the other
  // side of the loop). Web only: on desktop there is no public reading view to fall back to.
  //
  // GATED ON `?from=n`, i.e. only for visitors the public route actually redirected here. An
  // unreadable note is NOT proof of a permission problem: `useNote` 404s for a moment right after
  // a note is created (before the metadata upsert lands), so bouncing on any unreadable state sent
  // people who had just clicked "New note" to a dead public page. Normal in-app 404s must keep
  // rendering the not-found state below, exactly as they did before this feature.
  const isWeb = !useDesktopCapabilities().has('global-shortcuts');

  React.useEffect(() => {
    if (!unreadable || !isWeb || typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('from') !== 'n') return;
    window.location.replace(`/n/${noteId}?public=1`);
  }, [unreadable, isWeb, noteId]);

  if (isLoading) {
    return <NoteDetailSkeleton />;
  }
  if (unreadable) {
    // On web this frame is transient — the effect above is already navigating away. It stays as
    // the honest terminal state for desktop, and for the moment before the redirect commits.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <span className="text-4xl">📭</span>
        <p className="text-sm font-medium">{t('pages.noteNotFound.title')}</p>
        <p className="text-xs">{t('pages.noteNotFound.body')}</p>
      </div>
    );
  }
  return <NoteEditor key={note!.id} note={note!} />;
}
