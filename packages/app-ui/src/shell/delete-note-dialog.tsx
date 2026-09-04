'use client';

import { Loader2 } from 'lucide-react';
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
import { useTranslation } from 'react-i18next';

interface DeleteNoteDialogProps {
  /** The note to delete; the dialog is open while this is non-null. */
  note: { id: string; title: string } | null;
  onCancel: () => void;
  onConfirm: () => void;
  /** True while the delete is in flight — disables the buttons and shows a spinner. */
  pending?: boolean;
}

// Confirms note deletion from the sidebar row. Copy matches the in-editor delete confirm.
export function DeleteNoteDialog({
  note,
  onCancel,
  onConfirm,
  pending = false,
}: DeleteNoteDialogProps) {
  const { t } = useTranslation();
  return (
    <AlertDialog
      open={note !== null}
      onOpenChange={open => {
        // Don't let an outside click / Esc dismiss the dialog mid-delete.
        if (!open && !pending) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('dialogs.deleteNote.title', {
              title: note?.title || t('dialogs.deleteNote.untitled'),
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('dialogs.deleteNote.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} disabled={pending}>
            {t('common.actions.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={e => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {pending ? t('common.status.deleting') : t('common.actions.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
