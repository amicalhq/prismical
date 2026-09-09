'use client';

import * as React from 'react';
import { Loader2, Copy, X, Globe, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
import { Badge } from '../ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { copyToClipboard } from '../lib/clipboard';
import { useActiveOrgId } from '@prismical/app-client';
import { useEnv } from '@prismical/app-client';
import { EVENTS, usePorts } from '@prismical/app-client';
import { useOrgMembers } from '@prismical/app-client';
import {
  useNoteMembers,
  useFolderMembers,
  useUpdateShare,
  useResourceInvitations,
  useCreateResourceInvitation,
  useRevokeResourceInvitation,
  useNotePublication,
  usePublishNote,
  useUnpublishNote,
  type ResourceType,
  type ShareRole,
  type ShareMember,
} from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

function initials(name: string, email: string): string {
  const base = name?.trim() || email?.trim() || '?';
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

export interface ShareDialogProps {
  resourceType: ResourceType;
  resourceId: string;
  resourceTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShareDialog({
  resourceType,
  resourceId,
  resourceTitle,
  open,
  onOpenChange,
}: ShareDialogProps) {
  const { t } = useTranslation();
  const isNote = resourceType === 'note';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-md">
        <DialogHeader className="min-w-0 pr-6">
          <DialogTitle className="truncate" title={resourceTitle}>
            {t('sharing.title', { title: resourceTitle })}
          </DialogTitle>
          <DialogDescription>
            {isNote ? t('sharing.accessDescriptionNote') : t('sharing.accessDescriptionFolder')}
          </DialogDescription>
        </DialogHeader>
        <div className="mt-2 min-w-0">
          <PeoplePanel
            resourceType={resourceType}
            resourceId={resourceId}
            publicLink={isNote ? <PublicLinkSection noteId={resourceId} /> : null}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── People ──────────────────────────────────────────────────────────────────────

function PeoplePanel({
  resourceType,
  resourceId,
  publicLink,
}: {
  resourceType: ResourceType;
  resourceId: string;
  publicLink?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { analytics } = usePorts();
  const activeOrgId = useActiveOrgId();
  const orgMembers = useOrgMembers(activeOrgId);

  const noteMembers = useNoteMembers(resourceType === 'note' ? resourceId : null);
  const folderMembers = useFolderMembers(resourceType === 'folder' ? resourceId : null);
  const data = resourceType === 'note' ? noteMembers.data : folderMembers.data;
  const isLoading = resourceType === 'note' ? noteMembers.isLoading : folderMembers.isLoading;

  const invitations = useResourceInvitations(resourceType, resourceId);
  const updateShare = useUpdateShare(resourceType, resourceId);
  const createInvite = useCreateResourceInvitation(resourceType, resourceId);
  const revokeInvite = useRevokeResourceInvitation(resourceType, resourceId);

  const canManage = data?.canManage ?? false;
  // Whether the members query is in no-answer territory. The publication endpoint is the
  // AUTHORITATIVE gate on the public link (it 403s for non-sharers, and the section then removes
  // itself); `canManage` only spares viewers a request they'd lose anyway. So when the members
  // query can't answer, defer to the publication query instead of hiding Unpublish from the owner
  // of a note that is still publicly live.
  const membersUnknown = resourceType === 'note' ? noteMembers.isError : folderMembers.isError;
  const [value, setValue] = React.useState('');
  const [role, setRole] = React.useState<ShareRole>('viewer');
  const [error, setError] = React.useState<string | null>(null);

  const inherited = resourceType === 'note' ? (noteMembers.data?.inherited ?? []) : [];

  async function onAdd() {
    setError(null);
    const v = value.trim();
    if (!v) return;
    if (!isEmail(v)) {
      setError(t('sharing.emailInvalid'));
      return;
    }
    // An existing org member → grant directly (instant). Otherwise invite by email.
    const member = orgMembers.data?.find(m => m.email.toLowerCase() === v.toLowerCase());
    try {
      if (member) {
        await updateShare.mutateAsync({ add: [{ orgUserId: member.orgUserId, role }] });
        toast.success(t('sharing.sharedWith', { name: member.name || v }));
      } else {
        await createInvite.mutateAsync({ email: v, role });
        toast.success(t('sharing.invitationSent', { email: v }));
      }
      analytics.capture(EVENTS.RESOURCE_SHARED, {
        resource_type: resourceType,
        resource_id: resourceId,
        method: member ? 'organization_member' : 'email_invitation',
        role,
      });
      setValue('');
    } catch {
      setError(t('sharing.couldNotShare'));
    }
  }

  const busy = updateShare.isPending || createInvite.isPending;

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="space-y-2">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <Input
              className="col-span-2 sm:col-span-1"
              placeholder={t('sharing.addByEmail')}
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void onAdd();
              }}
            />
            <Select value={role} onValueChange={v => setRole(v as ShareRole)}>
              <SelectTrigger className="w-28 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">{t('sharing.roles.viewer')}</SelectItem>
                <SelectItem value="editor">{t('sharing.roles.editor')}</SelectItem>
                <SelectItem value="manager">{t('sharing.roles.manager')}</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={() => void onAdd()} disabled={busy} className="shrink-0">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.actions.share')}
            </Button>
          </div>
          {isEmail(value) &&
            !orgMembers.data?.some(m => m.email.toLowerCase() === value.trim().toLowerCase()) && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Mail className="h-3 w-3" />
                {t('sharing.notInOrganization')}
              </p>
            )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      )}

      {/* Managing the public link needs the same permission as managing members (core gates both
          on the share ceiling), so a plain viewer must not be shown a Publish button that can
          only ever 403. */}
      {(canManage || membersUnknown) && publicLink}

      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('sharing.peopleWithAccess')}
        </p>
        {isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="max-h-60 divide-y overflow-y-auto">
            {data && (
              <PersonRow
                name={
                  data.owner.isSelf ? t('sharing.you', { name: data.owner.name }) : data.owner.name
                }
                email={data.owner.email}
                image={data.owner.image}
                right={<Badge variant="secondary">{t('sharing.owner')}</Badge>}
              />
            )}
            {data?.members.map(m => (
              <MemberRow
                key={m.orgUserId}
                member={m}
                canManage={canManage}
                onRole={r =>
                  void updateShare.mutateAsync({ add: [{ orgUserId: m.orgUserId, role: r }] })
                }
                onRemove={() => void updateShare.mutateAsync({ remove: [m.orgUserId] })}
              />
            ))}
            {inherited.map(m => (
              <PersonRow
                key={`inh-${m.orgUserId}`}
                name={m.name}
                email={m.email}
                muted
                right={
                  <span className="text-xs text-muted-foreground">
                    {t('sharing.inheritedRole', {
                      role: t(`sharing.roles.${m.role}` as never),
                    })}
                  </span>
                }
              />
            ))}
          </div>
        )}
      </div>

      {(invitations.data?.length ?? 0) > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('sharing.pendingInvitations')}
          </p>
          <div className="max-h-40 divide-y overflow-y-auto">
            {invitations.data!.map(inv => (
              <PersonRow
                key={inv.id}
                name={inv.email}
                email={`${t(`sharing.roles.${inv.role}` as never)} · ${t('sharing.pending')}`}
                right={
                  canManage ? (
                    <button
                      type="button"
                      aria-label={t('sharing.revokeInvitation')}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => void revokeInvite.mutate(inv.id)}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  ) : null
                }
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PersonRow({
  name,
  email,
  image,
  right,
  muted,
}: {
  name: string;
  email: string;
  image?: string | null;
  right?: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 py-2 ${muted ? 'opacity-60' : ''}`}>
      <Avatar className="h-8 w-8 rounded-lg">
        {image ? <AvatarImage src={image} alt="" className="rounded-lg" /> : null}
        <AvatarFallback className="rounded-lg text-xs">{initials(name, email)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="truncate text-xs text-muted-foreground">{email}</p>
      </div>
      {right}
    </div>
  );
}

function MemberRow({
  member,
  canManage,
  onRole,
  onRemove,
}: {
  member: ShareMember;
  canManage: boolean;
  onRole: (r: ShareRole) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <PersonRow
      name={member.isSelf ? t('sharing.you', { name: member.name }) : member.name}
      email={member.email}
      image={member.image}
      right={
        canManage ? (
          <div className="flex items-center gap-1">
            <Select value={member.role} onValueChange={v => onRole(v as ShareRole)}>
              <SelectTrigger className="h-8 w-24 border-none text-xs shadow-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">{t('sharing.roles.viewer')}</SelectItem>
                <SelectItem value="editor">{t('sharing.roles.editor')}</SelectItem>
                <SelectItem value="manager">{t('sharing.roles.manager')}</SelectItem>
              </SelectContent>
            </Select>
            <button
              type="button"
              aria-label={t('sharing.removeMember')}
              className="text-muted-foreground hover:text-destructive"
              onClick={onRemove}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            {t(`sharing.roles.${member.role}` as never)}
          </span>
        )
      }
    />
  );
}

// ── Public link ──────────────────────────────────────────────────────────────────

/** Wraps a disabled control so the tooltip still fires (disabled buttons swallow pointer events). */
function PolicyTooltip({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <TooltipProvider>
      <Tooltip delayDuration={100}>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="shrink-0">
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-center">
          {t('sharing.policyDisabledHint')}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PublicLinkSection({ noteId }: { noteId: string }) {
  const { t } = useTranslation();
  const { analytics } = usePorts();
  const { webAppOrigin } = useEnv();
  const publication = useNotePublication(noteId);
  const publish = usePublishNote(noteId);
  const unpublish = useUnpublishNote(noteId);

  // Nothing trustworthy to render: core refused the read (no share permission) or doesn't know
  // this note yet (created offline, metadata not yet synced). Showing a Publish button here would
  // only ever produce an error, and `allowed` below deliberately defaults optimistic.
  //
  // `&& !data` matters: React Query keeps the last good data on a failed REFETCH, and this section
  // now triggers refetches of its own (see the mutations' onSettled). Without the guard, one flaky
  // refetch would take the whole section away — including the Unpublish button — from a note that
  // is still live, with nothing on screen saying so.
  if (publication.isError && !publication.data) return null;

  // Optimistic default. Only core actually saying `false` means an admin turned public sharing
  // off; defaulting to `false` made every not-yet-loaded fetch accuse an admin of something they
  // hadn't done, and hid a control that in fact worked.
  const allowed = publication.data?.allowPublicSharing ?? true;
  const active = !!publication.data?.publishedAt;
  // The organization policy pauses access without removing publication state. Offering the link
  // while access is paused would give the user a URL that cannot currently be opened.
  const paused = active && !allowed;
  // The note id IS the handle, so the URL exists whether or not it currently resolves.
  const url = `${webAppOrigin}/n/${noteId}`;

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('sharing.publicLink')}
          </p>
          {/* Always-visible, because the tooltip on the disabled button is unreachable without a
              hover: on touch there is no hover at all, and the portaled tooltip lands among the
              siblings a modal Radix dialog marks aria-hidden. The tooltip carries the longer
              "ask an admin" line; this says the essential part on its own. */}
          <p className="mt-0.5 text-xs text-muted-foreground">
            {paused
              ? t('sharing.publicLinkPaused')
              : !allowed
                ? t('sharing.policyDisabled')
                : active
                  ? t('sharing.publicLinkActive')
                  : t('sharing.publicLinkInactive')}
          </p>
        </div>
        {/* isPending, not isLoading: `isLoading` is pending AND fetching, so it goes false while a
            query is pending-but-PAUSED — which is what an offline browser does under the default
            networkMode. That state has no data, so `allowed` would fall back to its optimistic
            `true` and render an enabled Publish button. `isPending` covers every no-data case. */}
        {publication.isPending ? (
          <Loader2 className="mt-1 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        ) : active ? (
          // Unpublish stays available even when the org policy is off — core allows it on purpose,
          // so an admin flipping the switch can never trap a published note its owner can't clear.
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 text-destructive hover:text-destructive"
            onClick={() => unpublish.mutate()}
            disabled={unpublish.isPending}
          >
            {unpublish.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t('common.actions.unpublish')}
          </Button>
        ) : !allowed ? (
          // Disabled + explained, rather than clickable-then-403.
          <PolicyTooltip>
            <Button size="sm" disabled>
              <Globe className="h-4 w-4" />
              {t('common.actions.publish')}
            </Button>
          </PolicyTooltip>
        ) : (
          <Button
            size="sm"
            className="shrink-0"
            onClick={() =>
              // Failures are toasted by the hook itself, not here — a per-call onError is dropped
              // once this dialog unmounts, which is exactly when a user publishes and closes.
              publish.mutate(undefined, {
                onSuccess: () =>
                  analytics.capture(EVENTS.RESOURCE_SHARED, {
                    resource_type: 'note',
                    resource_id: noteId,
                    method: 'public_link',
                    role: 'viewer',
                  }),
              })
            }
            disabled={publish.isPending}
          >
            {publish.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Globe className="h-4 w-4" />
            )}
            {t('common.actions.publish')}
          </Button>
        )}
      </div>

      {active ? (
        <div className="flex items-center gap-2">
          <Input
            readOnly
            value={url}
            onFocus={e => e.currentTarget.select()}
            className={`h-8 flex-1 font-mono text-xs${paused ? ' opacity-60' : ''}`}
          />
          {paused ? (
            <PolicyTooltip>
              <Button size="sm" variant="secondary" disabled>
                <Copy className="h-3.5 w-3.5" />
                {t('common.actions.copy')}
              </Button>
            </PolicyTooltip>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              className="shrink-0"
              onClick={() =>
                void copyToClipboard(url).then(ok =>
                  ok
                    ? toast.success(t('sharing.linkCopied'))
                    : toast.error(t('sharing.couldNotCopy'))
                )
              }
            >
              <Copy className="h-3.5 w-3.5" />
              {t('common.actions.copy')}
            </Button>
          )}
        </div>
      ) : null}

      {/* Honest about what unpublishing does. There is no link rotation: the handle is the note
          id, so unpublishing is a pause and re-publishing revives every link ever sent. */}
      {active ? (
        <p className="text-[11px] text-muted-foreground">
          {paused ? t('sharing.linkRestoredHint') : t('sharing.linkUnpublishHint')}
        </p>
      ) : null}
    </div>
  );
}
