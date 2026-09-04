'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../ui/alert-dialog';
import { useDeleteAccount } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

// Account screen. The web-only auth wiring — the active
// account's email and sign-out — stays in the thin web wrapper (which reads
// AuthProvider) and arrives here as props, so the body is framework-free.
export function AccountScreen({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [confirmText, setConfirmText] = React.useState('');
  const del = useDeleteAccount();

  // Require typing the exact account email to arm the destructive button — the
  // gold-standard guard for an irreversible, account-wide action.
  const armed = email.length > 0 && confirmText.trim().toLowerCase() === email.toLowerCase();

  const onOpenChange = (next: boolean) => {
    // Don't let an outside click / Esc dismiss mid-delete.
    if (del.isPending) return;
    setOpen(next);
    if (!next) {
      setConfirmText('');
      del.reset();
    }
  };

  const handleConfirm = () => {
    if (!armed) return;
    del.mutate(undefined, {
      onSuccess: () => {
        // Session is already invalidated server-side; clear the local account and
        // let the AuthGuard bounce to the sign-in screen.
        onSignOut();
      },
    });
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-xl font-bold">{t('settings.account.title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('settings.account.description')}</p>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.account.signedInTitle')}</CardTitle>
            <CardDescription>{t('settings.account.signedInDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-medium text-foreground">{email || '—'}</p>
          </CardContent>
        </Card>

        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-destructive">{t('settings.account.dangerTitle')}</CardTitle>
            <CardDescription>{t('settings.account.dangerDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <Label className="text-base font-medium text-foreground">
                  {t('settings.account.delete')}
                </Label>
                <p className="text-sm text-muted-foreground">
                  {t('settings.account.deleteDescription')}
                </p>
              </div>
              <Button variant="destructive" onClick={() => setOpen(true)}>
                {t('settings.account.delete')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.account.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>{t('settings.account.confirmDescription')}</div>
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-2">
            <Label htmlFor="confirm-email" className="text-sm">
              {t('settings.account.confirmInstruction', { email })}
            </Label>
            <Input
              id="confirm-email"
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              autoComplete="off"
              disabled={del.isPending}
              aria-label={t('settings.account.confirmAria')}
            />
            {del.isError && (
              <p className="text-sm text-destructive" role="alert">
                {t('settings.account.error')}
              </p>
            )}
          </div>

          <AlertDialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={del.isPending}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirm}
              disabled={!armed || del.isPending}
            >
              {del.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {del.isPending ? t('settings.account.deleting') : t('settings.account.delete')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
