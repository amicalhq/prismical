'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { useTranslation } from 'react-i18next';

const MAX_NAME = 100;

interface FolderNameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "create" for a new folder, "rename" to edit an existing one. Drives the copy + seed value. */
  mode: 'create' | 'rename';
  /** Seed value for rename; ignored (treated as empty) for create. */
  initialName?: string;
  /** True while the create/rename mutation is in flight — disables inputs and shows a spinner. */
  pending?: boolean;
  /** Called with the trimmed, non-empty name. The parent owns the mutation and closes on success. */
  onSubmit: (name: string) => void;
}

// A single dialog for both creating and renaming a folder — the two flows differ only in copy,
// the seed value, and whether an unchanged name is allowed. Kept dumb: the parent supplies
// `pending` and runs the mutation in `onSubmit`, mirroring how ShareDialog/DeleteSkillDialog are wired.
export function FolderNameDialog({
  open,
  onOpenChange,
  mode,
  initialName = '',
  pending = false,
  onSubmit,
}: FolderNameDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = React.useState(initialName);
  // Unique id so the label association stays correct even if two instances briefly co-mount
  // (e.g. a palette-create dialog overlapping a sidebar dialog's exit animation).
  const inputId = React.useId();

  // Reseed each time the dialog opens: empty for create, the current name for rename.
  React.useEffect(() => {
    if (open) setName(mode === 'rename' ? initialName : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const trimmed = name.trim();
  const unchanged = mode === 'rename' && trimmed === initialName.trim();
  const submitDisabled = pending || trimmed.length === 0 || trimmed.length > MAX_NAME || unchanged;

  const isCreate = mode === 'create';
  const handleSubmit = () => {
    if (submitDisabled) return;
    onSubmit(trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={next => !pending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isCreate ? t('dialogs.folder.createTitle') : t('dialogs.folder.renameTitle')}
          </DialogTitle>
          <DialogDescription>
            {isCreate
              ? t('dialogs.folder.createDescription')
              : t('dialogs.folder.renameDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={inputId}>{t('common.fields.name')}</Label>
          <Input
            id={inputId}
            autoFocus
            maxLength={MAX_NAME}
            placeholder={t('dialogs.folder.namePlaceholder')}
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleSubmit();
            }}
          />
        </div>
        <DialogFooter className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t('common.actions.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitDisabled}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            {isCreate ? t('dialogs.folder.createAction') : t('common.actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
