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

interface DeleteFolderDialogProps {
  /** The folder to delete; the dialog is open while this is non-null. */
  folder: { id: string; name: string } | null;
  onCancel: () => void;
  onConfirm: () => void;
  /** True while the delete is in flight — disables the buttons and shows a spinner. */
  pending?: boolean;
}

// Confirms folder deletion. The notes inside are preserved (core atomically clears their folder links),
// so the copy reassures rather than warns about data loss.
export function DeleteFolderDialog({
  folder,
  onCancel,
  onConfirm,
  pending = false,
}: DeleteFolderDialogProps) {
  const { t } = useTranslation();
  return (
    <AlertDialog
      open={folder !== null}
      onOpenChange={open => {
        // Don't let an outside click / Esc dismiss the dialog mid-delete.
        if (!open && !pending) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('dialogs.deleteFolder.title', { name: folder?.name ?? '' })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('dialogs.deleteFolder.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} disabled={pending}>
            {t('common.actions.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            // Keep the dialog open while deleting; the parent closes it once the mutation settles.
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
