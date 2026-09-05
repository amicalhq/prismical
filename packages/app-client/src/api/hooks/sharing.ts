"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AcceptShareInvitationResponseSchema,
  FolderMembersResponseSchema,
  NoteMembersResponseSchema,
  NotePublicationResponseSchema,
  NotePublicationStateResponseSchema,
  OrganizationSharingPolicyResponseSchema,
  ResourceInvitationResponseSchema,
  ResourceInvitationsResponseSchema,
  RevokedPublicLinksResponseSchema,
  ShareFolderResponseSchema,
  ShareInvitationDetailResponseSchema,
  ShareNoteResponseSchema,
  type FolderMembersResponse,
  type NoteMembersResponse,
  type NotePublicationStateResponse,
  type ResourceInvitation,
  type ShareInvitationDetail,
  type ShareRole,
  type SharedResourceType,
} from "@prismical/api-contracts/apps/v1";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { ApiError, apiClient, ME_PREFIX } from "../client";
import { organizationsKey } from "./organizations";
import { useSyncStore } from "../../sync/provider";

// Note/folder sharing. Mirrors the org hooks style.

export type {
  NotePublication,
  ResourceInvitation,
  ShareInvitationDetail,
  ShareMember,
  ShareOwner,
  ShareRole,
} from "@prismical/api-contracts/apps/v1";
export type ResourceType = SharedResourceType;

const seg = (type: ResourceType) => (type === "note" ? "notes" : "folders");

export type NoteMembersResult = NoteMembersResponse;
export type FolderMembersResult = FolderMembersResponse;

/**
 * Publication state of a note. There is no link resource any more: the note id is
 * the public handle, so `publishedAt` is the entire state and the URL is always
 * `${webAppOrigin}/n/${noteId}`.
 */
export type NotePublicationState = NotePublicationStateResponse;

export const noteMembersKey = (id: string) => ["note-members", id] as const;
export const folderMembersKey = (id: string) => ["folder-members", id] as const;
export const notePublicationKey = (id: string) => ["note-publication", id] as const;
export const resourceInvitationsKey = (type: ResourceType, id: string) =>
  ["resource-invitations", type, id] as const;
export const shareInvitationKey = (id: string) => ["share-invitation", id] as const;

export const ROLE_TO_PERMISSIONS: Record<ShareRole, string[]> = {
  viewer: ["read"],
  editor: ["write"],
  manager: ["manage"],
};

// ── Members ───────────────────────────────────────────────────────────────────

export function useNoteMembers(noteId: string | null) {
  return useQuery<NoteMembersResult>({
    queryKey: noteMembersKey(noteId ?? ""),
    enabled: !!noteId,
    queryFn: async () =>
      NoteMembersResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/notes/${noteId}/members`),
      ),
  });
}

export function useFolderMembers(folderId: string | null) {
  return useQuery<FolderMembersResult>({
    queryKey: folderMembersKey(folderId ?? ""),
    enabled: !!folderId,
    queryFn: async () =>
      FolderMembersResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/folders/${folderId}/members`),
      ),
  });
}

function membersKey(type: ResourceType, id: string) {
  return type === "note" ? noteMembersKey(id) : folderMembersKey(id);
}

/** Add / change a member's role, or remove members. The backend upserts on add. */
export function useUpdateShare(type: ResourceType, id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.sharingUpdate" },
    mutationFn: async (vars: {
      add?: { orgUserId: string; role: ShareRole }[];
      remove?: string[];
    }) => {
      const response = await apiClient.putRaw<unknown>(`${ME_PREFIX}/${seg(type)}/${id}/share`, {
        add: (vars.add ?? []).map((a) => ({
          orgUserId: a.orgUserId,
          permissions: ROLE_TO_PERMISSIONS[a.role],
        })),
        remove: vars.remove ?? [],
      });
      return type === "note"
        ? ShareNoteResponseSchema.parse(response)
        : ShareFolderResponseSchema.parse(response);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: membersKey(type, id) }),
  });
}

// ── By-email invitations ────────────────────────────────────────────────────────

export function useResourceInvitations(type: ResourceType, id: string | null) {
  return useQuery<ResourceInvitation[]>({
    queryKey: resourceInvitationsKey(type, id ?? ""),
    enabled: !!id,
    queryFn: async () =>
      ResourceInvitationsResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/${seg(type)}/${id}/invitations`),
      ).results,
  });
}

export function useCreateResourceInvitation(type: ResourceType, id: string) {
  const qc = useQueryClient();
  return useMutation({
    // The invite form renders the error inline.
    meta: { suppressErrorToast: true },
    mutationFn: async (vars: { email: string; role: ShareRole }) =>
      ResourceInvitationResponseSchema.parse(
        await apiClient.postRaw<unknown>(`${ME_PREFIX}/${seg(type)}/${id}/invitations`, vars),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: resourceInvitationsKey(type, id) }),
  });
}

export function useRevokeResourceInvitation(type: ResourceType, id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.invitationRevoke" },
    mutationFn: (invitationId: string) =>
      apiClient.del(`${ME_PREFIX}/share-invitations/${invitationId}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: resourceInvitationsKey(type, id) }),
  });
}

// ── Publication (notes only) ─────────────────────────────────────────────────────

export function useNotePublication(noteId: string | null) {
  return useQuery<NotePublicationState>({
    queryKey: notePublicationKey(noteId ?? ""),
    enabled: !!noteId,
    queryFn: async () =>
      NotePublicationStateResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/notes/${noteId}/publish`),
      ),
  });
}

/** Core's code for "your organization has public link sharing turned off" (a 403). */
export const PUBLIC_SHARING_DISABLED = "PUBLIC_SHARING_DISABLED";

export function usePublishNote(noteId: string) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  return useMutation({
    // Opt out of the generic toast so a policy 403 can read as itself rather than as "try again".
    meta: { suppressErrorToast: true },
    mutationFn: async () =>
      NotePublicationResponseSchema.parse(
        await apiClient.postRaw<unknown>(`${ME_PREFIX}/notes/${noteId}/publish`, {}),
      ),
    // This MUST live on the hook, not on the caller's `mutate(..., { onError })`: per-call
    // callbacks are gated on the observer still having listeners, so they are dropped once the
    // component unmounts. Publishing then closing the dialog is an ordinary thing to do, and it
    // would swallow the failure entirely — the one outcome `MutationCache.onError` exists to
    // prevent. Hook-level callbacks are invoked by the mutation itself and always fire.
    onError: (error) =>
      toast.error(
        error instanceof ApiError && error.code === PUBLIC_SHARING_DISABLED
          ? t("sharing.policyDisabledHint")
          : t("common.mutationErrors.publishNote"),
      ),
    // onSettled, not onSuccess: a failure usually means the cached state is what's wrong (an admin
    // turned the org policy off in another session), so refetching is exactly what fixes the UI.
    onSettled: () => void qc.invalidateQueries({ queryKey: notePublicationKey(noteId) }),
  });
}

export function useUnpublishNote(noteId: string) {
  const qc = useQueryClient();
  return useMutation({
    // "Unpublish", not "revoke": with no token to rotate, re-publishing revives the same URL.
    meta: { errorMessageKey: "common.mutationErrors.unpublishNote" },
    mutationFn: () => apiClient.del(`${ME_PREFIX}/notes/${noteId}/publish`),
    onSettled: () => void qc.invalidateQueries({ queryKey: notePublicationKey(noteId) }),
  });
}

// ── Org sharing policy (owner/admin) ─────────────────────────────────────────────

export function useUpdateSharingPolicy(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.sharingPolicyUpdate" },
    mutationFn: async (allowPublicSharing: boolean) =>
      OrganizationSharingPolicyResponseSchema.parse(
        await apiClient.patchRaw<unknown>(
          `${ME_PREFIX}/organizations/${orgId}/sharing-policy`,
          { allowPublicSharing },
          { activeOrgId: orgId },
        ),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: organizationsKey }),
  });
}

export function useUnpublishAllNotes(orgId: string) {
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.unpublishNotes" },
    mutationFn: async () =>
      RevokedPublicLinksResponseSchema.parse(
        await apiClient.postRaw<unknown>(
          `${ME_PREFIX}/organizations/${orgId}/public-links/revoke-all`,
          {},
          { activeOrgId: orgId },
        ),
      ),
  });
}

// ── Invitee-facing accept ────────────────────────────────────────────────────────

export function useShareInvitation(id: string | null) {
  return useQuery<ShareInvitationDetail>({
    queryKey: shareInvitationKey(id ?? ""),
    enabled: !!id,
    retry: false,
    queryFn: async () =>
      ShareInvitationDetailResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/share-invitations/${id}`),
      ),
  });
}

export function useAcceptShareInvitation() {
  const syncStore = useSyncStore();
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: async (id: string) =>
      AcceptShareInvitationResponseSchema.parse(
        await apiClient.postRaw<unknown>(`${ME_PREFIX}/share-invitations/${id}/accept`, {}),
      ),
    // The newly-granted note/folder must show up immediately — nudge a delta
    // pull so the post-accept redirect resolves it (and it lands in "Shared
    // with me"). (Share grants bump updatedAt server-side, so the delta sees them.)
    onSuccess: () => void syncStore?.refreshAll(),
  });
}

// The unauthenticated public-note read (fetchPublicNote / PublicNote) stays in
// the WEB shell — it powers the web-only `/n/[token]` public route, reads the
// browser-host server URL, and has no desktop counterpart.
// See the web app's public-note API helper.
