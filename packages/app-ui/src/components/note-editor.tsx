'use client';

import { useState } from 'react';
import { tiptapJsonToMarkdown } from '@prismical/editor-markdown';
import { toast } from 'sonner';
import {
  useDesktopCapabilities,
  useEntitlements,
  useFeatureFlag,
  useNavigation,
} from '@prismical/app-client';
import {
  Star,
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
import { NoteEventChips } from './note-event-chips';
import { useRegisterCurrentNote } from '../shell/current-note-context';
import { useCurrentNoteEditor } from '../shell/current-editor-context';
import type { Note } from '@prismical/app-contracts';
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
  const router = useNavigation();
  const caps = useDesktopCapabilities();
  // Floating mode is a plan feature as well as a desktop capability (see the pop-out button).
  const { entitlements } = useEntitlements();
  const canFloat = caps.has('floating-note') && entitlements.features.floatingMode;
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
  const { editor, editorNoteId } = useCurrentNoteEditor();
  const canCopyMarkdown = editor !== null && !editor.isDestroyed && editorNoteId === note.id;

  // Publish this note to the layout-level recording cluster, which renders the
  // dock + transcription panel for it (the transcript lives there, not inline).
  // Pass the live title so edits flow through to the dock/header.
  useRegisterCurrentNote({
    noteId: note.id,
    title,
    transcript: note.transcript ?? [],
  });

  const copyAsMarkdown = async () => {
    if (!canCopyMarkdown || !editor) return;
    try {
      // The metadata body can lag behind collaborative edits. Serialize the loaded
      // editor at click time so both local and remote edits are included.
      const body = tiptapJsonToMarkdown(editor.getJSON());
      const copied = await copyToClipboard(`# ${title}\n\n${body}`);
      if (copied) toast.success(t('settings.apiMcp.clipboard.copiedText'));
      else toast.error(t('settings.apiMcp.clipboard.textError'));
    } catch {
      toast.error(t('settings.apiMcp.clipboard.textError'));
    }
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
        {canFloat && (
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
            <DropdownMenuItem
              className="gap-2"
              disabled={!canCopyMarkdown}
              onSelect={copyAsMarkdown}
            >
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

      {/* ── Metadata row: folder + tags + meetings ──────────────────── */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5 pl-11">
        <NoteFolderChip
          value={folderId}
          onChange={id => {
            setFolderId(id);
            update.mutate({ folderId: id ?? undefined });
          }}
        />
        <NoteTagEditor noteId={note.id} selected={note.tagIds ?? []} />
        <NoteEventChips noteId={note.id} writable={note.writable ?? true} />
      </div>

      {/* ── Body (collaborative editor) ───────────────────────────────── */}
      {/* ph-mask-content: masks the note body text in PostHog session
          recordings while the surrounding chrome stays visible. */}
      {/* mt-4 stands in for the removed divider's breathing room. */}
      <div data-onboarding="note-body" className="ph-mask-content mt-8">
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
