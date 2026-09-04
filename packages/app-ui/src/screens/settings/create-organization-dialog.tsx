'use client';

import * as React from 'react';
import { useNavigation } from '@prismical/app-client';
import { Loader2 } from 'lucide-react';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { useCreateOrganization } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

// Create a new organization. On success the hook switches the active organization to
// the new one; we then land the user on its Members page so the natural next
// step (inviting teammates) is one click away.
export function CreateOrganizationDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const router = useNavigation();
  const create = useCreateOrganization();
  const [name, setName] = React.useState('');

  React.useEffect(() => {
    if (open) {
      setName('');
      create.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const trimmed = name.trim();
  const submitDisabled = create.isPending || trimmed.length === 0 || trimmed.length > 64;

  const handleSubmit = () => {
    if (submitDisabled) return;
    create.mutate(trimmed, {
      onSuccess: () => {
        onOpenChange(false);
        router.push('/settings/members');
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={next => !create.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings.organization.create.title')}</DialogTitle>
          <DialogDescription>{t('settings.organization.create.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="organization-name">{t('settings.organization.create.nameLabel')}</Label>
            <Input
              id="organization-name"
              autoFocus
              maxLength={64}
              placeholder={t('settings.organization.create.namePlaceholder')}
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSubmit();
              }}
            />
          </div>
          {create.error && (
            <p className="text-sm text-destructive">{t('settings.organization.create.error')}</p>
          )}
        </div>
        <DialogFooter className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            {t('common.actions.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitDisabled}>
            {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('settings.organization.create.action')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
