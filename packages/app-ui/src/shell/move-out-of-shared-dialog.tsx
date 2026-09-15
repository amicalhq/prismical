'use client';

import * as React from 'react';
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

/**
 * The one warning before a move takes a note or a folder out of a shared folder: the people who
 * reached it through that folder lose it. Kept dumb like the other confirmations: the parent
 * decides when to ask and does the move on confirm.
 */
export function MoveOutOfSharedDialog({
  open,
  what,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** Which kind of thing is moving; the copy names it. */
  what: 'note' | 'folder';
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={next => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('dialogs.moveOutOfShared.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {what === 'note'
              ? t('dialogs.moveOutOfShared.noteDescription')
              : t('dialogs.moveOutOfShared.folderDescription')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{t('common.actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t('dialogs.moveOutOfShared.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
