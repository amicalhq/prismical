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

interface DeleteTagDialogProps {
  /** The tag to delete; the dialog is open while this is non-null. */
  tag: { id: string; name: string } | null;
  onCancel: () => void;
  onConfirm: () => void;
  /** True while the delete is in flight — disables the buttons and shows a spinner. */
  pending?: boolean;
}

// Confirms tag deletion. Deleting a tag removes it from every note it was attached to; the notes
// themselves are untouched.
export function DeleteTagDialog({
  tag,
  onCancel,
  onConfirm,
  pending = false,
}: DeleteTagDialogProps) {
  const { t } = useTranslation();
  return (
    <AlertDialog
      open={tag !== null}
      onOpenChange={open => {
        // Don't let an outside click / Esc dismiss the dialog mid-delete.
        if (!open && !pending) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('dialogs.deleteTag.title', { name: tag?.name ?? '' })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('dialogs.deleteTag.description')}</AlertDialogDescription>
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
