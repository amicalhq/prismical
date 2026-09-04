'use client';

import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../../ui/alert-dialog';
import type { Skill } from '../../mock-data';
import { skillDisplayName } from '../../../../lib/skill-presentation';

interface DeleteSkillDialogProps {
  skill: Skill | null;
  onCancel: () => void;
  onConfirm: () => void;
  /** True while the delete is in flight — disables the buttons and shows a spinner. */
  pending?: boolean;
}

// Faithful port of the desktop `DeleteSkillDialog` — opens when a skill is set,
// confirms before removing it from the library.
export function DeleteSkillDialog({
  skill,
  onCancel,
  onConfirm,
  pending = false,
}: DeleteSkillDialogProps) {
  const { t } = useTranslation();
  return (
    <AlertDialog
      open={skill !== null}
      onOpenChange={open => {
        // Don't let an outside click / Esc dismiss the dialog mid-delete.
        if (!open && !pending) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('settings.skillLibrary.delete.title', {
              name: skill ? skillDisplayName(skill, t) : '',
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('settings.skillLibrary.delete.description')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} disabled={pending}>
            {t('settings.skillLibrary.actions.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            // Keep the dialog open while deleting; the parent closes it (or
            // navigates away) once the mutation settles.
            onClick={e => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {pending
              ? t('settings.skillLibrary.actions.deleting')
              : t('settings.skillLibrary.actions.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
