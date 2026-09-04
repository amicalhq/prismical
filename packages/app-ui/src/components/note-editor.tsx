'use client';

import { useState } from 'react';
import { useDesktopCapabilities, useFeatureFlag, useNavigation } from '@prismical/app-client';
import {
  Star,
  Calendar,
  FileText,
  MoreHorizontal,
  ClipboardCopy,
  PictureInPicture2,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { NoteFolderChip } from './note-folder-chip';
import { NoteTagEditor } from './note-tag-editor';
import { useRegisterCurrentNote } from '../shell/current-note-context';
import type { Note } from '@prismical/app-contracts';
import { useEvent } from '@prismical/app-client';
import {
  formatApplicationEventDateLabel,
  formatApplicationEventTimeRange,
  useApplicationLocale,
} from '@prismical/app-i18n';
import { copyToClipboard } from '../lib/clipboard';
import { useUpdateNote, useDeleteNote } from '@prismical/app-client';
import { NoteTitleField } from './note-title-field';
import { NoteBodyEditor } from './note-body-editor';
import { ShareDialog } from '../shell/share-dialog';
import { useTranslation } from 'react-i18next';

// ─── Static emoji picker ──────────────────────────────────────────────────────

const QUICK_EMOJIS = [
  '📝',
  '📋',
  '📌',
  '🗒️',
  '🗓️',
  '💡',
  '🔍',
  '✅',
  '🌅',
  '🗺️',
  '📚',
  '🖥️',
  '🌿',
  '🔬',
  '💡',
  '💬',
  '📋',
  '🎨',
  '⭐',
  '🚀',
  '💼',
  '🏆',
  '📊',
  '🔧',
];

// ─── NoteEditor ───────────────────────────────────────────────────────────────

interface NoteEditorProps {
  note: Note;
}

export function NoteEditor({ note }: NoteEditorProps) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const router = useNavigation();
  const caps = useDesktopCapabilities();
  const [title, setTitle] = useState(note.title);
  const [emoji, setEmoji] = useState<string | undefined>(note.emoji);
  const [starred, setStarred] = useState(note.starred);
  const [folderId, setFolderId] = useState<string | null>(note.folderId ?? null);
  const [showDelete, setShowDelete] = useState(false);
  const [showShare, setShowShare] = useState(false);
  // Sharing is an org feature (off in the desktop local workspace).
  const { enabled: sharingEnabled } = useFeatureFlag('sharing');
  const update = useUpdateNote(note.id);
  const del = useDeleteNote();

  const event = useEvent(note.eventId);

  // Publish this note to the layout-level recording cluster, which renders the
  // dock + transcription panel for it (the transcript lives there, not inline).
  // Pass the live title so edits flow through to the dock/header.
  useRegisterCurrentNote({
    noteId: note.id,
    title,
    transcript: note.transcript ?? [],
  });

  const copyAsMarkdown = async () => {
    // Best-effort: copyToClipboard already swallows failures and falls back to
    // execCommand, so there's nothing more to handle here.
    await copyToClipboard(`# ${title}\n\n${note.body}`);
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-32 pt-2 md:px-6">
      {/* ── Header: emoji + title + star + actions ───────────────────── */}
      <div className="mb-2 flex items-start gap-1">
        {/* Emoji button */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 h-10 w-10 shrink-0 p-0 hover:bg-accent"
              aria-label={t('notes.actions.changeEmoji')}
            >
              {emoji ? (
                <span className="text-2xl leading-none">{emoji}</span>
              ) : (
                <FileText className="h-5 w-5 text-muted-foreground" />
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-2" align="start">
            <div className="mb-2 flex items-center justify-between px-1">
              <p className="text-xs text-muted-foreground">{t('notes.pickEmoji')}</p>
              {emoji ? (
                <button
                  type="button"
                  onClick={() => {
                    setEmoji(undefined);
                    update.mutate({ emoji: undefined });
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {t('common.actions.remove')}
                </button>
              ) : null}
            </div>
            <div className="grid grid-cols-8 gap-0.5">
              {QUICK_EMOJIS.map((em, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setEmoji(em);
                    update.mutate({ emoji: em });
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded text-lg hover:bg-accent"
                  aria-label={em}
                >
                  {em}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        <NoteTitleField key={note.id} note={note} onTitleChange={setTitle} />

        {/* Pop out to the floating note (desktop only).
                Icon semantics (locked): the PiP glyph lives ONLY here. */}
        {caps.has('floating-note') && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void caps.openFloatingNote(note.id)}
            className="mt-1 h-8 w-8 shrink-0 p-0 hover:bg-accent"
            aria-label={t('notes.actions.popOut')}
            title={t('notes.actions.popOut')}
          >
            <PictureInPicture2 className="h-4 w-4 text-muted-foreground" />
          </Button>
        )}

        {/* Share */}
        {sharingEnabled && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowShare(true)}
            className="mt-1 h-8 shrink-0 gap-1.5 px-2 hover:bg-accent"
            aria-label={t('notes.actions.share')}
          >
            <UserPlus className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{t('common.actions.share')}</span>
          </Button>
        )}

        {/* Star toggle */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const next = !starred;
            setStarred(next);
            update.mutate({ starred: next });
          }}
          className="mt-1 h-8 w-8 shrink-0 p-0 hover:bg-accent"
          aria-label={starred ? t('notes.actions.unstar') : t('notes.actions.star')}
        >
          <Star
            className={`h-4 w-4 transition-colors ${
              starred ? 'fill-yellow-400 text-yellow-400' : 'text-muted-foreground'
            }`}
          />
        </Button>

        {/* Actions menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 h-8 w-8 shrink-0 p-0 hover:bg-accent"
              aria-label={t('notes.actions.noteActions')}
            >
              <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="gap-2" onSelect={copyAsMarkdown}>
              <ClipboardCopy className="h-4 w-4" />
              {t('notes.actions.copyMarkdown')}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="gap-2 text-destructive focus:text-destructive"
              onSelect={() => setShowDelete(true)}
            >
              <Trash2 className="h-4 w-4" />
              {t('common.actions.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* ── Metadata row: folder + tags ──────────────────────────────── */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5 pl-11">
        <NoteFolderChip
          value={folderId}
          onChange={id => {
            setFolderId(id);
            update.mutate({ folderId: id ?? undefined });
          }}
        />
        <NoteTagEditor noteId={note.id} selected={note.tagIds ?? []} />
      </div>

      {/* ── Meeting row ───────────────────────────────────────────────── */}
      {event && (
        <div className="mb-4 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-11 text-sm text-muted-foreground">
          {/* No color dot here: the calendar icon beside it is already tinted with the source
                  calendar's color, so a dot would say the same thing twice (note-card does the same). */}
          <Calendar className="h-3.5 w-3.5 shrink-0" style={{ color: event.calendarColor }} />
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                title={event.title}
                className="max-w-full truncate rounded px-1 py-0.5 font-medium text-foreground transition-colors hover:bg-accent"
              >
                {event.title}
              </button>
            </PopoverTrigger>
            <PopoverContent side="bottom" align="start" sideOffset={6} className="w-80 p-0">
              <div className="flex items-start gap-3 p-3">
                <span
                  aria-hidden="true"
                  className="mt-0.5 h-8 w-1.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: event.calendarColor }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{event.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {formatApplicationEventDateLabel(
                      new Date(event.start),
                      event.isAllDay ?? false,
                      new Date(),
                      resolvedLocale,
                      t
                    )}{' '}
                    <span aria-hidden="true">•</span>{' '}
                    {formatApplicationEventTimeRange(
                      new Date(event.start),
                      new Date(event.end),
                      event.isAllDay ?? false,
                      resolvedLocale,
                      t
                    )}
                  </p>
                  {event.joinUrl ? (
                    <a
                      href={event.joinUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-flex items-center rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                    >
                      {t('notes.joinMeeting')}
                    </a>
                  ) : null}
                  {event.attendees && event.attendees.length > 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('notes.attendeeCount', {
                        count: event.attendees.length,
                      })}
                    </p>
                  ) : null}
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      )}

      {/* ── Body (collaborative editor) ───────────────────────────────── */}
      {/* ph-mask-content: masks the note body text in PostHog session
          recordings while the surrounding chrome stays visible. */}
      {/* mt-4 stands in for the removed divider's breathing room. */}
      <div className="ph-mask-content mt-8">
        <NoteBodyEditor noteId={note.id} writable={note.writable ?? true} />
      </div>

      {/* ── Delete confirmation ───────────────────────────────────────── */}
      <AlertDialog open={showDelete} onOpenChange={setShowDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('dialogs.deleteNote.title', {
                title: title || t('notes.untitled'),
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('dialogs.deleteNote.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              // Navigate first so this editor unmounts before the optimistic
              // delete empties the cache (otherwise the derived note briefly
              // becomes undefined and flashes "Note not found"). If the delete
              // fails, the list rollback + global toast surface it on /notes.
              onClick={() => {
                router.push('/notes');
                del.mutate(note.id);
              }}
            >
              {t('common.actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {sharingEnabled && (
        <ShareDialog
          resourceType="note"
          resourceId={note.id}
          resourceTitle={title || t('notes.untitled')}
          open={showShare}
          onOpenChange={setShowShare}
        />
      )}
    </div>
  );
}
