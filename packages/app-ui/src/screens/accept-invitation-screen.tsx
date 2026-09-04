'use client';

import * as React from 'react';
import { useNavigation, useInvitation, useAcceptInvitation } from '@prismical/app-client';
import { Loader2, MailX, PartyPopper, Users } from 'lucide-react';
import { Avatar, AvatarFallback } from '../ui/avatar';
import { Button } from '../ui/button';
import { useTranslation } from 'react-i18next';

// Accept-invitation screen. The web-only multi-account auth
// wiring — the active account's email, org switch, and "add account" — stays in
// the thin web wrapper (which reads AuthProvider) and arrives here as props, so
// the presentational body is framework-free.
//
// The landing page for a copyable /accept-invitation/<id>
// link. Behind AuthGuard (the visitor is signed in; if they arrived logged out,
// the returnTo capture brings them back here after sign-in). Verifies the invite
// is for THIS account, then joins the organization.

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center gap-5 px-6 text-center">
      {children}
    </div>
  );
}

function getInitials(name?: string | null): string {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

export function AcceptInvitationScreen({
  id,
  currentEmail,
  onSwitchOrg,
  onAddAccount,
}: {
  id: string | null;
  currentEmail: string;
  onSwitchOrg: (orgId: string) => void;
  onAddAccount: () => void;
}) {
  const { t } = useTranslation();
  const router = useNavigation();

  const { data: invite, isLoading, error } = useInvitation(id);
  const accept = useAcceptInvitation();

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
        <MailX className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">{t('invitations.common.notFound')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('invitations.organization.notFoundBody')}
          </p>
        </div>
        <Button variant="outline" onClick={() => router.replace('/home')}>
          {t('invitations.common.goHome')}
        </Button>
      </Card>
    );
  }

  // Happy path — the invite is valid and addressed to this account.
  if (invite.canAccept) {
    return (
      <Card>
        <Avatar className="h-14 w-14 rounded-xl">
          <AvatarFallback className="rounded-xl text-lg">
            {getInitials(invite.organizationName)}
          </AvatarFallback>
        </Avatar>
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">
            {t('invitations.organization.join', { organization: invite.organizationName })}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('invitations.organization.invited', {
              inviter: invite.inviterName,
              role:
                invite.role === 'owner'
                  ? t('invitations.organization.roles.owner')
                  : invite.role === 'admin'
                    ? t('invitations.organization.roles.admin')
                    : t('invitations.organization.roles.member'),
            })}
          </p>
        </div>
        {accept.error && (
          <p className="text-sm text-destructive">{t('invitations.organization.acceptError')}</p>
        )}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            onClick={() => router.replace('/home')}
            disabled={accept.isPending}
          >
            {t('invitations.common.notNow')}
          </Button>
          <Button
            onClick={() => accept.mutate(invite.id, { onSuccess: () => router.replace('/home') })}
            disabled={accept.isPending}
            data-testid="accept-invitation"
          >
            {accept.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Users className="h-4 w-4" />
            )}
            {t('invitations.organization.joinAction')}
          </Button>
        </div>
      </Card>
    );
  }

  // Already a member — nothing to accept; offer to open the organization.
  if (invite.reason === 'already-accepted') {
    return (
      <Card>
        <PartyPopper className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">{t('invitations.organization.alreadyTitle')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('invitations.organization.alreadyBody', {
              organization: invite.organizationName,
            })}
          </p>
        </div>
        <Button
          onClick={() => {
            onSwitchOrg(invite.organizationId);
            router.replace('/home');
          }}
        >
          {t('invitations.organization.open')}
        </Button>
      </Card>
    );
  }

  // Wrong account — the invite is for a different email than the one signed in.
  if (invite.reason === 'wrong-account') {
    return (
      <Card>
        <MailX className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">
            {t('invitations.organization.wrongAccountTitle')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('invitations.organization.wrongAccountBody', {
              invitedEmail: invite.email,
              currentEmail,
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => router.replace('/home')}>
            {t('invitations.common.goHome')}
          </Button>
          <Button onClick={() => onAddAccount()}>
            {t('invitations.organization.switchAccount')}
          </Button>
        </div>
      </Card>
    );
  }

  // Expired or canceled.
  return (
    <Card>
      <MailX className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">
          {invite.reason === 'expired'
            ? t('invitations.organization.expiredTitle')
            : t('invitations.organization.canceledTitle')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {invite.reason === 'expired'
            ? t('invitations.organization.expiredBody', { inviter: invite.inviterName })
            : t('invitations.organization.canceledBody', { inviter: invite.inviterName })}
        </p>
      </div>
      <Button variant="outline" onClick={() => router.replace('/home')}>
        {t('invitations.common.goHome')}
      </Button>
    </Card>
  );
}
