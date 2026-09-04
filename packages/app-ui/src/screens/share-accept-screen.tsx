'use client';

import { useNavigation, useShareInvitation, useAcceptShareInvitation } from '@prismical/app-client';
import { Loader2, MailX, FileText, FolderOpen } from 'lucide-react';
import { Button } from '../ui/button';
import { Avatar, AvatarFallback } from '../ui/avatar';
import { useTranslation } from 'react-i18next';

// Share-accept screen. The Next route param is unwrapped by the
// thin web wrapper and handed in as `id`, so the screen stays framework-free.

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border p-8 text-center">
        {children}
      </div>
    </div>
  );
}

export function ShareAcceptScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const router = useNavigation();
  const { data: invite, isLoading, error } = useShareInvitation(id);
  const accept = useAcceptShareInvitation();

  if (isLoading) {
    return (
      <Card>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t('invitations.common.loading')}</p>
      </Card>
    );
  }

  if (error || !invite) {
    return (
      <Card>
        <MailX className="h-10 w-10 text-muted-foreground" />
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">{t('invitations.common.notFound')}</h1>
          <p className="text-sm text-muted-foreground">{t('invitations.share.notFoundBody')}</p>
        </div>
        <Button variant="outline" onClick={() => router.replace('/home')}>
          {t('invitations.common.goHome')}
        </Button>
      </Card>
    );
  }

  if (!invite.canAccept) {
    const copy =
      invite.reason === 'wrong-account'
        ? {
            title: t('invitations.share.wrongAccountTitle'),
            body: t('invitations.share.wrongAccountBody'),
          }
        : invite.reason === 'already-accepted'
          ? {
              title: t('invitations.share.alreadyAcceptedTitle'),
              body: t('invitations.share.alreadyAcceptedBody'),
            }
          : invite.reason === 'revoked'
            ? {
                title: t('invitations.share.revokedTitle'),
                body: t('invitations.share.revokedBody'),
              }
            : invite.reason === 'expired'
              ? {
                  title: t('invitations.share.expiredTitle'),
                  body: t('invitations.share.expiredBody'),
                }
              : invite.reason === 'unavailable'
                ? {
                    title: t('invitations.share.unavailableTitle'),
                    body: t('invitations.share.unavailableBody'),
                  }
                : {
                    title: t('invitations.share.genericTitle'),
                    body: t('invitations.share.genericBody'),
                  };
    return (
      <Card>
        <MailX className="h-10 w-10 text-muted-foreground" />
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">{copy.title}</h1>
          <p className="text-sm text-muted-foreground">{copy.body}</p>
          {invite.reason === 'wrong-account' && (
            <p className="pt-1 text-xs text-muted-foreground">
              {t('invitations.share.forEmail', { email: invite.email })}
            </p>
          )}
        </div>
        <Button variant="outline" onClick={() => router.replace('/home')}>
          {t('invitations.common.goHome')}
        </Button>
      </Card>
    );
  }

  const Icon = invite.resourceType === 'folder' ? FolderOpen : FileText;
  return (
    <Card>
      <Avatar className="h-14 w-14 rounded-xl">
        <AvatarFallback className="rounded-xl">
          <Icon className="h-6 w-6" />
        </AvatarFallback>
      </Avatar>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{invite.resourceTitle}</h1>
        <p className="text-sm text-muted-foreground">
          {t('invitations.share.shared', {
            inviter: invite.inviterName || t('invitations.share.someone'),
            resource: invite.resourceType === 'folder' ? t('sharing.folder') : t('sharing.note'),
            role:
              invite.role === 'editor'
                ? t('sharing.roles.editor')
                : invite.role === 'manager'
                  ? t('sharing.roles.manager')
                  : t('sharing.roles.viewer'),
          })}
        </p>
      </div>
      {accept.error && (
        <p className="text-sm text-destructive">{t('invitations.share.acceptError')}</p>
      )}
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={() => router.replace('/home')} disabled={accept.isPending}>
          {t('invitations.common.notNow')}
        </Button>
        <Button
          onClick={() =>
            accept.mutate(id, {
              onSuccess: res => {
                router.replace(res.resourceType === 'note' ? `/notes/${res.resourceId}` : '/home');
              },
            })
          }
          disabled={accept.isPending}
        >
          {accept.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t('invitations.share.open', {
            resource: invite.resourceType === 'folder' ? t('sharing.folder') : t('sharing.note'),
          })}
        </Button>
      </div>
    </Card>
  );
}
