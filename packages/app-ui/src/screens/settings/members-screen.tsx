'use client';

import * as React from 'react';
import { useApplicationLocale, type ApplicationTFunction } from '@prismical/app-i18n';
import { useTranslation } from 'react-i18next';
import { Copy, Loader2, Mail, Plus, UserMinus, Users } from 'lucide-react';
import { toast } from 'sonner';
import { AppLink as Link } from '../../shell/app-link';
import { Avatar, AvatarFallback, AvatarImage } from '../../ui/avatar';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Switch } from '../../ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../ui/tooltip';
import { copyToClipboard } from '../../lib/clipboard';
import { DataError } from '../../components/data-error';
import { ListRowsSkeleton } from '../../components/skeletons';
import { CreateOrganizationDialog } from './create-organization-dialog';
import { useActiveOrgId, useEnv } from '@prismical/app-client';
import {
  useOrganizations,
  useOrgMembers,
  useOrgInvitations,
  useUpdateMemberRole,
  useRemoveMember,
  useRenameOrganization,
  useCreateInvitation,
  useCancelInvitation,
  type OrgMember,
  type OrgInvitation,
  type OrganizationRole,
} from '@prismical/app-client';
import { useUpdateSharingPolicy, useUnpublishAllNotes } from '@prismical/app-client';

// Organization members + invitations for the active organization.
// Owners/admins manage; plain members see a read-only roster. Inviting emails the
// invitee an accept link and copies a /accept-invitation/<id> link to
// the clipboard as a fallback.

const MANAGE_ROLES = new Set(['owner', 'admin']);

// Select hands its callback a bare `string`. Narrow at that boundary instead of casting, so a
// value outside the contract's union is dropped rather than posted to the API.
const ORGANIZATION_ROLES = [
  'owner',
  'admin',
  'member',
] as const satisfies readonly OrganizationRole[];

// A `readonly OrganizationRole[]` annotation would accept a SUBSET, so a role added to the
// contract would compile here and then be silently swallowed by the guard below — a Select that
// visibly refuses to change, with no error anywhere. The tuple-wrapped check is non-distributive,
// so it fails compilation instead. (Distributing would resolve to `true | never` = `true` and
// catch nothing.)
type _EnsureAllRolesListed = [OrganizationRole] extends [(typeof ORGANIZATION_ROLES)[number]]
  ? true
  : never;
const _rolesAreExhaustive: _EnsureAllRolesListed = true;
const isOrganizationRole = (value: string): value is OrganizationRole =>
  (ORGANIZATION_ROLES as readonly string[]).includes(value);

type InvitableRole = Extract<OrganizationRole, 'admin' | 'member'>;
const isInvitableRole = (value: string): value is InvitableRole =>
  value === 'admin' || value === 'member';

function getInitials(name?: string | null, email?: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  }
  if (email) return (email.split('@')[0] ?? email).substring(0, 2).toUpperCase();
  return '??';
}

function roleLabel(role: string, t: ApplicationTFunction): string {
  switch (role) {
    case 'owner':
      return t('settings.members.roles.owner');
    case 'admin':
      return t('settings.members.roles.admin');
    case 'member':
      return t('settings.members.roles.member');
    default:
      return role;
  }
}

function inviteLink(webAppOrigin: string, id: string): string {
  // webAppOrigin is the browser origin on web (empty during SSR → a relative
  // path, matching the previous typeof-window fallback); the EnvPort seam is
  // what desktop swaps for the web origin.
  return `${webAppOrigin}/accept-invitation/${id}`;
}

async function copy(text: string, label: string, t: ApplicationTFunction): Promise<void> {
  if (await copyToClipboard(text)) {
    toast.success(label);
  } else {
    toast.error(t('settings.members.clipboard.copyError'));
  }
}

// ─── Member row ─────────────────────────────────────────────────────────────

// Role options the caller may assign. Owner > admin > member: only an owner can
// grant ownership, so non-owners don't see the Owner option.
function MemberRow({
  member,
  orgId,
  callerRole,
  ownerCount,
  onRemove,
  onPromoteToOwner,
}: {
  member: OrgMember;
  orgId: string;
  callerRole: string;
  ownerCount: number;
  onRemove: (m: OrgMember) => void;
  onPromoteToOwner: (m: OrgMember) => void;
}) {
  const { t } = useTranslation();
  const updateRole = useUpdateMemberRole(orgId);
  const iAmOwner = callerRole === 'owner';
  const canManage = callerRole === 'owner' || callerRole === 'admin';
  const isOwner = member.role === 'owner';
  const isLastOwner = isOwner && ownerCount <= 1;
  const soleOwnerSelf = member.isSelf && isLastOwner;

  // Role is editable when: self → only an owner may step down, and only if not
  // the last owner; others → owner/admin may edit, but only an owner may touch
  // another owner.
  const editableRole = canManage
    ? member.isSelf
      ? iAmOwner && !isLastOwner
      : !isOwner || iAmOwner
    : false;

  // Removable: never the last owner; only an owner may remove an owner.
  const canRemoveOther = !member.isSelf && canManage && (isOwner ? iAmOwner && !isLastOwner : true);

  const roleOptions: readonly OrganizationRole[] = iAmOwner
    ? ORGANIZATION_ROLES
    : ORGANIZATION_ROLES.filter(r => r !== 'owner');

  const handleRoleChange = (role: OrganizationRole) => {
    if (role === member.role) return;
    // Granting ownership is significant — confirm before applying.
    if (role === 'owner') return onPromoteToOwner(member);
    updateRole.mutate({ orgUserId: member.orgUserId, role });
  };

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="member-row">
      <Avatar className="h-8 w-8 rounded-lg">
        {member.image ? <AvatarImage src={member.image} alt="" className="rounded-lg" /> : null}
        <AvatarFallback className="rounded-lg text-xs">
          {getInitials(member.name, member.email)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium leading-tight">{member.name || member.email}</span>
          {member.isSelf && (
            <Badge variant="outline" className="text-muted-foreground">
              {t('settings.members.member.you')}
            </Badge>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{member.email}</div>
      </div>

      {editableRole ? (
        <Select
          value={member.role}
          onValueChange={value => {
            if (isOrganizationRole(value)) handleRoleChange(value);
          }}
          disabled={updateRole.isPending}
        >
          <SelectTrigger className="w-28" data-testid="role-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {roleOptions.map(r => (
              <SelectItem key={r} value={r}>
                {roleLabel(r, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Badge variant={isOwner ? 'secondary' : 'outline'}>{roleLabel(member.role, t)}</Badge>
      )}

      {member.isSelf ? (
        soleOwnerSelf ? (
          <TooltipProvider>
            <Tooltip delayDuration={100}>
              <TooltipTrigger asChild>
                {/* span wrapper so the tooltip still fires on the disabled button */}
                <span tabIndex={0}>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled
                    className="text-muted-foreground"
                    data-testid="leave-disabled"
                  >
                    {t('settings.members.actions.leave')}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-center">
                {t('settings.members.member.soleOwner')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onRemove(member)}
          >
            {t('settings.members.actions.leave')}
          </Button>
        )
      ) : canRemoveOther ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={t('settings.members.member.removeAria', {
            name: member.name || member.email,
          })}
          className="text-muted-foreground hover:text-destructive"
          onClick={() => onRemove(member)}
        >
          <UserMinus className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}

// ─── Remove / leave confirm ─────────────────────────────────────────────────

function RemoveMemberDialog({
  member,
  orgId,
  onOpenChange,
}: {
  member: OrgMember | null;
  orgId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const remove = useRemoveMember(orgId);
  const leaving = member?.isSelf ?? false;

  React.useEffect(() => {
    if (member) remove.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member]);

  const handleConfirm = () => {
    if (!member) return;
    remove.mutate(member.orgUserId, { onSuccess: () => onOpenChange(false) });
  };

  return (
    <Dialog open={member !== null} onOpenChange={n => !remove.isPending && onOpenChange(n)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {leaving
              ? t('settings.members.remove.leaveTitle')
              : t('settings.members.remove.removeTitle', {
                  name: member?.name || member?.email,
                })}
          </DialogTitle>
          <DialogDescription>
            {leaving
              ? t('settings.members.remove.leaveDescription')
              : t('settings.members.remove.removeDescription')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={remove.isPending}>
            {t('settings.members.actions.cancel')}
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={remove.isPending}>
            {remove.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {leaving
              ? t('settings.members.actions.leaveOrganization')
              : t('settings.members.actions.remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Promote-to-owner confirm ───────────────────────────────────────────────

function PromoteOwnerDialog({
  member,
  orgId,
  onOpenChange,
}: {
  member: OrgMember | null;
  orgId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const updateRole = useUpdateMemberRole(orgId);

  React.useEffect(() => {
    if (member) updateRole.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member]);

  const handleConfirm = () => {
    if (!member) return;
    updateRole.mutate(
      { orgUserId: member.orgUserId, role: 'owner' },
      { onSuccess: () => onOpenChange(false) }
    );
  };

  return (
    <Dialog open={member !== null} onOpenChange={n => !updateRole.isPending && onOpenChange(n)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('settings.members.promote.title', {
              name: member?.name || member?.email,
            })}
          </DialogTitle>
          <DialogDescription>{t('settings.members.promote.description')}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex justify-end gap-2 pt-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={updateRole.isPending}
          >
            {t('settings.members.actions.cancel')}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={updateRole.isPending}
            data-testid="confirm-make-owner"
          >
            {updateRole.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('settings.members.actions.makeOwner')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Organization name (rename) ─────────────────────────────────────────────────

/** Owner/admin control: org-wide public link sharing toggle + a one-time revoke-all kill switch. */
function PublicSharingControl({ orgId, allowed }: { orgId: string; allowed: boolean }) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const policy = useUpdateSharingPolicy(orgId);
  const unpublishAll = useUnpublishAllNotes(orgId);
  const [confirming, setConfirming] = React.useState(false);

  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">{t('settings.members.sharing.allowLabel')}</p>
          <p className="text-xs text-muted-foreground">
            {t('settings.members.sharing.allowDescription')}
          </p>
        </div>
        <Switch
          aria-label={t('settings.members.sharing.allowLabel')}
          checked={allowed}
          disabled={policy.isPending}
          onCheckedChange={next =>
            policy.mutate(next, {
              onSuccess: () =>
                toast.success(
                  next
                    ? t('settings.members.sharing.enabled')
                    : t('settings.members.sharing.disabled')
                ),
            })
          }
        />
      </div>
      <div className="flex items-center justify-between gap-4 border-t pt-3">
        <div>
          <p className="text-sm font-medium">{t('settings.members.sharing.unpublishAction')}</p>
          <p className="text-xs text-muted-foreground">
            {t('settings.members.sharing.unpublishDescription')}
          </p>
        </div>
        {confirming ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              {t('settings.members.actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={unpublishAll.isPending}
              onClick={() =>
                unpublishAll.mutate(undefined, {
                  onSuccess: res => {
                    setConfirming(false);
                    toast.success(
                      t('settings.members.sharing.unpublished', {
                        count: res.revoked,
                        countLabel: res.revoked.toLocaleString(resolvedLocale),
                      })
                    );
                  },
                })
              }
            >
              {unpublishAll.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                t('settings.members.actions.unpublishAll')
              )}
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 text-destructive hover:text-destructive"
            onClick={() => setConfirming(true)}
          >
            {t('settings.members.actions.unpublishAll')}
          </Button>
        )}
      </div>
    </div>
  );
}

function OrganizationNameForm({ orgId, currentName }: { orgId: string; currentName: string }) {
  const { t } = useTranslation();
  const rename = useRenameOrganization(orgId);
  const [name, setName] = React.useState(currentName);

  // Keep the input in sync when the organization (or its name) changes underneath.
  React.useEffect(() => {
    setName(currentName);
  }, [currentName]);

  const trimmed = name.trim();
  const disabled =
    rename.isPending || trimmed.length === 0 || trimmed.length > 64 || trimmed === currentName;

  const save = () => {
    if (disabled) return;
    rename.mutate(trimmed);
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-56 flex-1 space-y-1.5">
        <Label htmlFor="organization-name">{t('settings.members.organization.nameLabel')}</Label>
        <Input
          id="organization-name"
          value={name}
          maxLength={64}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') save();
          }}
          data-testid="organization-name-input"
        />
      </div>
      <Button onClick={save} disabled={disabled} data-testid="organization-name-save">
        {rename.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        {t('settings.members.actions.save')}
      </Button>
    </div>
  );
}

// ─── Invite form ────────────────────────────────────────────────────────────

function InviteForm({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const invite = useCreateInvitation(orgId);
  const { webAppOrigin } = useEnv();
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<InvitableRole>('member');

  const trimmed = email.trim();
  const disabled = invite.isPending || trimmed.length === 0;

  const handleInvite = () => {
    if (disabled) return;
    invite.mutate(
      { email: trimmed, role },
      {
        onSuccess: created => {
          setEmail('');
          void copy(
            inviteLink(webAppOrigin, created.id),
            t('settings.members.clipboard.invitationSent'),
            t
          );
        },
      }
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="email"
          placeholder={t('settings.members.invite.emailPlaceholder')}
          value={email}
          className="min-w-56 flex-1"
          onChange={e => setEmail(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleInvite();
          }}
        />
        <Select
          value={role}
          onValueChange={value => {
            if (isInvitableRole(value)) setRole(value);
          }}
        >
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="admin">{t('settings.members.roles.admin')}</SelectItem>
            <SelectItem value="member">{t('settings.members.roles.member')}</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={handleInvite} disabled={disabled}>
          {invite.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          {t('settings.members.actions.invite')}
        </Button>
      </div>
      {invite.error ? (
        (invite.error as { code?: string }).code === 'SEAT_LIMIT_REACHED' ? (
          // The plan's seat gate: the server's own sentence names the limit; the fix is a plan.
          <p className="text-sm text-destructive">
            {invite.error.message}{' '}
            <Link href="/settings/billing" className="font-medium text-primary hover:underline">
              {t('settings.billing.screen.gateSeePlans')}
            </Link>
          </p>
        ) : (
          <p className="text-sm text-destructive">{t('settings.members.invite.error')}</p>
        )
      ) : (
        <p className="text-xs text-muted-foreground">{t('settings.members.invite.description')}</p>
      )}
    </div>
  );
}

// ─── Pending invitation row ─────────────────────────────────────────────────

function InvitationRow({ invitation, orgId }: { invitation: OrgInvitation; orgId: string }) {
  const { t } = useTranslation();
  const cancel = useCancelInvitation(orgId);
  const { webAppOrigin } = useEnv();
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="invitation-row">
      <Mail className="h-[18px] w-[18px] shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium leading-tight">{invitation.email}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {t('settings.members.invitations.row', {
            role: roleLabel(invitation.role, t),
            status: t('settings.members.invitations.pending'),
          })}
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() =>
          void copy(
            inviteLink(webAppOrigin, invitation.id),
            t('settings.members.clipboard.inviteLinkCopied'),
            t
          )
        }
      >
        <Copy className="h-3.5 w-3.5" />
        {t('settings.members.actions.copyLink')}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="text-muted-foreground hover:text-destructive"
        disabled={cancel.isPending}
        onClick={() => cancel.mutate(invitation.id)}
      >
        {cancel.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          t('settings.members.actions.cancel')
        )}
      </Button>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function MembersScreen() {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const activeOrgId = useActiveOrgId();
  const orgsQuery = useOrganizations();
  const activeOrg = orgsQuery.data?.find(o => o.orgId === activeOrgId) ?? null;
  const callerRole = activeOrg?.role ?? '';
  const canManage = MANAGE_ROLES.has(callerRole);

  const membersQuery = useOrgMembers(activeOrgId);
  const invitationsQuery = useOrgInvitations(canManage ? activeOrgId : null);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [removeTarget, setRemoveTarget] = React.useState<OrgMember | null>(null);
  const [promoteTarget, setPromoteTarget] = React.useState<OrgMember | null>(null);

  const members = membersQuery.data ?? [];
  const invitations = invitationsQuery.data ?? [];
  const ownerCount = members.filter(m => m.role === 'owner').length;

  return (
    <div className="mx-auto w-full max-w-4xl">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{t('settings.members.screen.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t(
              canManage
                ? 'settings.members.organization.managedDescription'
                : 'settings.members.organization.readonlyDescription',
              {
                name: activeOrg?.name || t('settings.members.organization.fallbackName'),
              }
            )}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setCreateOpen(true)}
          data-testid="create-organization"
        >
          <Plus className="h-4 w-4" />
          {t('settings.members.actions.newOrganization')}
        </Button>
      </div>

      {/* Organization name (owner/admin only) */}
      {canManage && activeOrgId && (
        <div className="mb-8 space-y-3">
          <h2 className="text-sm font-semibold">{t('settings.members.organization.title')}</h2>
          <OrganizationNameForm orgId={activeOrgId} currentName={activeOrg?.name ?? ''} />
        </div>
      )}

      {/* Public sharing policy (owner/admin only) */}
      {canManage && activeOrgId && (
        <div className="mb-8 space-y-3">
          <h2 className="text-sm font-semibold">{t('settings.members.sharing.title')}</h2>
          <PublicSharingControl
            orgId={activeOrgId}
            allowed={activeOrg?.allowPublicSharing ?? true}
          />
        </div>
      )}

      {/* Invite (owner/admin only) */}
      {canManage && activeOrgId && (
        <div className="mb-8 space-y-3">
          <h2 className="text-sm font-semibold">{t('settings.members.invite.title')}</h2>
          <InviteForm orgId={activeOrgId} />
        </div>
      )}

      {/* Members */}
      <div className="mb-8 space-y-3">
        <h2 className="text-sm font-semibold">
          {members.length > 0
            ? t('settings.members.roster.count', {
                count: members.length,
                countLabel: members.length.toLocaleString(resolvedLocale),
              })
            : t('settings.members.roster.title')}
        </h2>
        {membersQuery.isLoading ? (
          <div className="overflow-hidden rounded-xl bg-muted">
            <ListRowsSkeleton rows={3} />
          </div>
        ) : membersQuery.error ? (
          <DataError
            message={t('settings.members.roster.loadError')}
            onRetry={() => void membersQuery.refetch()}
          />
        ) : members.length === 0 ? (
          <div className="space-y-2 rounded-lg border border-dashed p-9 text-center">
            <Users className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">{t('settings.members.roster.empty')}</p>
          </div>
        ) : (
          <div className="divide-y rounded-xl border">
            {members.map(m => (
              <MemberRow
                key={m.orgUserId}
                member={m}
                orgId={activeOrgId!}
                callerRole={callerRole}
                ownerCount={ownerCount}
                onRemove={setRemoveTarget}
                onPromoteToOwner={setPromoteTarget}
              />
            ))}
          </div>
        )}
      </div>

      {/* Pending invitations (owner/admin only) */}
      {canManage && invitations.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">
            {t('settings.members.invitations.count', {
              count: invitations.length,
              countLabel: invitations.length.toLocaleString(resolvedLocale),
            })}
          </h2>
          <div className="divide-y rounded-xl border">
            {invitations.map(inv => (
              <InvitationRow key={inv.id} invitation={inv} orgId={activeOrgId!} />
            ))}
          </div>
        </div>
      )}

      <RemoveMemberDialog
        member={removeTarget}
        orgId={activeOrgId ?? ''}
        onOpenChange={open => !open && setRemoveTarget(null)}
      />
      <PromoteOwnerDialog
        member={promoteTarget}
        orgId={activeOrgId ?? ''}
        onOpenChange={open => !open && setPromoteTarget(null)}
      />
      <CreateOrganizationDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
