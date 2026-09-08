"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  AcceptInvitationResponseSchema,
  InvitationDetailResponseSchema,
  OrganizationInvitationResponseSchema,
  OrganizationInvitationsResponseSchema,
  OrganizationMembersResponseSchema,
  OrganizationResponseSchema,
  OrganizationsResponseSchema,
  RenamedOrganizationResponseSchema,
  UpdatedOrganizationMemberResponseSchema,
  type InvitationDetail,
  type Organization,
  type OrganizationInvitation,
  type OrganizationMember,
  type OrganizationRole,
  type PlanEntitlements,
} from "@prismical/api-contracts/apps/v1";
import { apiClient, ME_PREFIX } from "../client";
import { useActiveOrgId, usePorts } from "../../ports-context";
import { useDesktopCapabilities } from "../../settings/use-desktop-capabilities";
import { AUTO_PAUSE_DEFAULTS } from "@prismical/silence";

// OrganizationRole is re-exported so UI can type role pickers against the contract instead of
// widening to `string` — app-ui doesn't depend on @prismical/api-contracts directly.
export type {
  InvitationDetail,
  Organization,
  OrganizationRole,
  PlanEntitlements,
} from "@prismical/api-contracts/apps/v1";
export type OrgMember = OrganizationMember;
export type OrgInvitation = OrganizationInvitation;

/** Roles assignable in the UI. Owners aren't assignable via invite. */
export const ASSIGNABLE_ROLES = ["admin", "member"] as const;

export const organizationsKey = ["organizations"] as const;
export const orgMembersKey = (orgId: string) => ["org-members", orgId] as const;
export const orgInvitationsKey = (orgId: string) => ["org-invitations", orgId] as const;
export const invitationKey = (id: string) => ["invitation", id] as const;

/**
 * The organizations the user belongs to. Sends NO `x-active-org-id`
 * (`activeOrgId: null`) so it ALWAYS succeeds — even when the persisted active
 * org is stale — making it the reliable source for (re)selection. Ordered by
 * the server (oldest membership first), matching the backend's no-header default.
 */
export function useOrganizations(options: { enabled?: boolean } = {}) {
  return useQuery<Organization[]>({
    queryKey: organizationsKey,
    queryFn: async () =>
      OrganizationsResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/organizations`, undefined, {
          activeOrgId: null,
        }),
      ).results,
    staleTime: 5 * 60_000,
    enabled: options.enabled ?? true,
  });
}

/**
 * Loads the org list and guarantees a valid active organization: if none is picked,
 * or the persisted pick is no longer a membership, fall back to the first
 * (oldest) org — which matches the backend's no-header default. Mount once in the
 * app shell; returns the same query result as `useOrganizations`. `required`
 * resolves a concrete cloud workspace even when its switcher UI is disabled.
 */
export function useEnsureActiveOrg({ required = false }: { required?: boolean } = {}) {
  const query = useOrganizations();
  const activeOrgId = useActiveOrgId();
  const { switchOrg } = usePorts().auth;
  // A workspace without the organization feature (the desktop local
  // workspace) has nothing to ensure — its single org row IS the active org and
  // there is no org to switch to. The list still loads (it is served in-process).
  const { enabled: organizations } = useFeatureFlag("organization");
  const orgs = query.data;

  React.useEffect(() => {
    if (!organizations && !required) return;
    if (!orgs || orgs.length === 0) return;
    const valid = activeOrgId != null && orgs.some((o) => o.orgId === activeOrgId);
    if (!valid) switchOrg(orgs[0]!.orgId);
  }, [organizations, required, orgs, activeOrgId, switchOrg]);

  return query;
}

/**
 * The caller's currently-active organization (the one `x-active-org-id` points at),
 * or null while the org list is still loading or the active pick hasn't resolved.
 * Thin selector over `useOrganizations` + `useActiveOrgId` — the same lookup several
 * screens do inline.
 */
export function useActiveOrg(): Organization | null {
  const activeOrgId = useActiveOrgId();
  const { data } = useOrganizations();
  return data?.find((o) => o.orgId === activeOrgId) ?? null;
}

/**
 * Whether a feature is enabled for the active org. `isResolved` is
 * false only while the org list is still loading — gate **routes** on it so a direct
 * URL hit shows a loader instead of bouncing before the flag is known; **nav** can
 * ignore it and just read `enabled` (a hidden-then-shown link is harmless).
 *
 * The flag is read off the *effective* org: the active pick, else the first (oldest)
 * org — the same fallback `useEnsureActiveOrg` and the backend's no-`x-active-org-id`
 * default use, so it agrees with the data the page actually loads. The fallback is
 * load-bearing on mobile web, where the only mount of `useEnsureActiveOrg` lives in
 * the sidebar sheet (unmounted while closed), so `activeOrgId` can stay null; without
 * it a gated route would spin forever. `isResolved` flips true once the query settles
 * either way — on error (the whole app is degraded) or a zero-org account, `enabled`
 * is false and a route gate redirects home rather than hanging.
 */
/**
 * Cloud defaults for the flags that gate cloud-only surfaces.
 * Core only emits the operational flags in FEATURE_REGISTRY (integrations,
 * eventkitCalendar, autoPauseOnSilence, groqByok); these keys describe what a
 * cloud organization has by construction — members, billing, calendars,
 * sharing, automations, the public API, the account itself and the BYOK
 * instance CRUD — so an org that does not mention them resolves TRUE. A
 * platform that resolves its own flags (the desktop local workspace, see
 * DesktopCapabilityPort.featureFlags) answers them itself, mostly false. Should
 * core ever register one of these server-side, its value wins.
 */
export const CLOUD_FEATURE_DEFAULTS: Readonly<Record<string, boolean>> = {
  account: true,
  automations: true,
  billing: true,
  byokInstances: true,
  calendar: true,
  organization: true,
  publicApi: true,
  sharing: true,
};

export function useFeatureFlag(key: string): { enabled: boolean; isResolved: boolean } {
  const { isEnabled, isResolved } = useFeatureFlags();
  return { enabled: isEnabled(key), isResolved };
}

/**
 * The same resolver as `useFeatureFlag`, for callers that read MANY flags (the
 * sidebar filters a nav list by `item.feature`): one org subscription, then
 * `isEnabled(key)` per key instead of one hook per key.
 */
export function useFeatureFlags(): { isEnabled: (key: string) => boolean; isResolved: boolean } {
  const activeOrgId = useActiveOrgId();
  // The platform's own resolver: when the port hands over a
  // flag table there is no organization to ask, so the answer is synchronous and
  // the org query is not fired for this hook. Unknown keys read false.
  const platformFlags = useDesktopCapabilities().featureFlags;
  const { data, isSuccess, isError } = useOrganizations({ enabled: platformFlags === null });
  if (platformFlags !== null) {
    return { isEnabled: (key) => platformFlags[key] ?? false, isResolved: true };
  }
  const org = data?.find((o) => o.orgId === activeOrgId) ?? data?.[0] ?? null;
  return {
    isEnabled: (key) => org?.features?.[key] ?? CLOUD_FEATURE_DEFAULTS[key] ?? false,
    isResolved: isSuccess || isError,
  };
}

/**
 * What a client resolves to when the org payload carries NO entitlements: a core that predates
 * them, or the desktop local workspace (no org). Everything on and unlimited — absent means "no
 * plan gate", never "off", so an older core can never lock a surface the server still allows.
 */
export const ENTITLEMENTS_UNGATED: PlanEntitlements = Object.freeze({
  planExternalId: null,
  features: Object.freeze({
    askAi: true,
    floatingMode: true,
    byok: true,
    automations: true,
    extendedRecording: true,
  }),
  aiModelTier: "pro",
  limits: Object.freeze({
    seats: null,
    cloudTranscriptionSeconds: null,
    aiCredits: null,
    maxRecordingSeconds: null,
  }),
  pooled: false,
});

/**
 * The active org's plan entitlements (Ask AI, BYOK, automations, floating mode, recording length,
 * seats, credits) — the client half of the server's plan gates. Rides the same organizations
 * query `useFeatureFlags()` reads, so a gate costs no request of its own. `isResolved` is false
 * only while that query is still loading; render permissively until then (a flash of an upgrade
 * hint on a paid org is worse than a late one on a free org).
 */
export function useEntitlements(): { entitlements: PlanEntitlements; isResolved: boolean } {
  const activeOrgId = useActiveOrgId();
  const platformFlags = useDesktopCapabilities().featureFlags;
  const { data, isSuccess, isError } = useOrganizations({ enabled: platformFlags === null });
  if (platformFlags !== null) return { entitlements: ENTITLEMENTS_UNGATED, isResolved: true };
  // No first-org fallback (unlike `useFeatureFlags`): an active org the stale list does not know
  // yet must resolve ungated, not to some OTHER org's plan — the server gates either way.
  const org = data?.find((o) => o.orgId === activeOrgId) ?? null;
  return {
    entitlements: org?.entitlements ?? ENTITLEMENTS_UNGATED,
    isResolved: isSuccess || isError,
  };
}

export interface AutoPausePolicy {
  enabled: boolean;
  silenceSeconds: number;
  graceSeconds: number;
  autoStopAfterPausedMinutes: number;
}

/**
 * Disabled, with coherent thresholds — what a cold cache or an older core resolves to. The numbers
 * come from the machine's own defaults rather than being restated here: a fourth copy of "100"
 * would agree today and drift the first time an operator changes one.
 */
export const AUTO_PAUSE_POLICY_OFF: AutoPausePolicy = {
  enabled: false,
  silenceSeconds: AUTO_PAUSE_DEFAULTS.silenceSeconds,
  graceSeconds: AUTO_PAUSE_DEFAULTS.graceSeconds,
  autoStopAfterPausedMinutes: AUTO_PAUSE_DEFAULTS.autoStopAfterPausedMinutes,
};

/**
 * The effective auto-pause policy for the active org: the `features` gate merged
 * with the server's tuning projection, over the client's own defaults.
 *
 * Read from the query CACHE rather than through `useOrganizations()`, deliberately. The policy is
 * needed exactly once, at `start()`, and subscribing `useRecording` to the org query would make
 * the hottest hook in the app re-render on unrelated org traffic — and would drag an org fixture
 * into every recording test. Same shape as `ensureModelDefault`, which the start path already
 * uses for the transcription model.
 *
 * Defaults are baked here as well as server-side on purpose: a cold cache, an older core, or a
 * desktop-native start must still produce a coherent DISABLED policy rather than NaN thresholds.
 * Nothing auto-pauses until the org list has actually resolved and said so.
 */
export async function ensureAutoPausePolicy(
  qc: QueryClient,
  activeOrgId: string | null,
  authToken?: string,
): Promise<AutoPausePolicy> {
  // ENSURE, not read. Reading a cold cache silently resolved to "off" for the WHOLE session — the
  // policy is captured once at start() — so a record button pressed before the org list landed
  // disabled the feature with no signal. An e2e caught exactly that. A failure here still yields
  // the disabled policy, which is the right way to fail.
  const orgs = await qc
    .ensureQueryData<Organization[]>({
      queryKey: organizationsKey,
      queryFn: async () =>
        OrganizationsResponseSchema.parse(
          await apiClient.getRaw<unknown>(`${ME_PREFIX}/organizations`, undefined, {
            activeOrgId: null,
            authToken,
          }),
        ).results,
      staleTime: 5 * 60_000,
    })
    .catch(() => undefined);
  // STRICT lookup, unlike useFeatureFlag's `?? data[0]` fallback. If the active org isn't in the
  // cached list (a stale list after switching or leaving an org), falling back to another org
  // could enable auto-pause from org A while recording into org B — where an admin may have
  // turned it off. A hidden nav link is a survivable consequence of that fallback; pausing a
  // recording the org disabled the feature for is not.
  const org = activeOrgId
    ? orgs?.find((o) => o.orgId === activeOrgId)
    : orgs?.length === 1
      ? orgs[0]
      : undefined;
  if (!org) return AUTO_PAUSE_POLICY_OFF;
  const t = org.transcription;
  return {
    enabled: org.features?.autoPauseOnSilence ?? false,
    silenceSeconds: t?.autoPauseSilenceSeconds ?? AUTO_PAUSE_POLICY_OFF.silenceSeconds,
    graceSeconds: t?.autoPauseGraceSeconds ?? AUTO_PAUSE_POLICY_OFF.graceSeconds,
    autoStopAfterPausedMinutes:
      t?.autoStopAfterPausedMinutes ?? AUTO_PAUSE_POLICY_OFF.autoStopAfterPausedMinutes,
  };
}

// ─── Create organization (3a) ────────────────────────────────────────────────────

/**
 * Create a new organization and switch into it. Seeds the org list cache with the
 * new organization BEFORE switching so `useEnsureActiveOrg` won't bounce the active
 * org back to results[0] before the refetch lands, then invalidates for fresh
 * member counts.
 */
export function useCreateOrganization() {
  const qc = useQueryClient();
  const { switchOrg } = usePorts().auth;
  return useMutation({
    // The dialog renders the create error inline.
    meta: { suppressErrorToast: true },
    mutationFn: async (name: string) =>
      OrganizationResponseSchema.parse(
        await apiClient.postRaw<unknown>(
          `${ME_PREFIX}/organizations`,
          { name },
          { activeOrgId: null },
        ),
      ),
    onSuccess: (created) => {
      qc.setQueryData<Organization[]>(organizationsKey, (old) =>
        old ? [...old, created] : [created],
      );
      switchOrg(created.orgId);
      void qc.invalidateQueries({ queryKey: organizationsKey });
    },
  });
}

/** Rename an organization (owner/admin). Invalidates the org list so the new name
 *  shows everywhere — the switcher, the page header, etc. */
export function useRenameOrganization(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.organizationRename" },
    mutationFn: async (name: string) =>
      RenamedOrganizationResponseSchema.parse(
        await apiClient.patchRaw<unknown>(
          `${ME_PREFIX}/organizations/${orgId}`,
          { name },
          { activeOrgId: orgId },
        ),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: organizationsKey }),
  });
}

// ─── Members (3b) ─────────────────────────────────────────────────────────────

export function useOrgMembers(orgId: string | null) {
  return useQuery<OrgMember[]>({
    queryKey: orgMembersKey(orgId ?? ""),
    enabled: !!orgId,
    queryFn: async () =>
      OrganizationMembersResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/organizations/${orgId}/members`, undefined, {
          activeOrgId: orgId,
        }),
      ).results,
  });
}

export function useUpdateMemberRole(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.organizationRoleUpdate" },
    mutationFn: async (vars: { orgUserId: string; role: OrganizationRole }) =>
      UpdatedOrganizationMemberResponseSchema.parse(
        await apiClient.patchRaw<unknown>(
          `${ME_PREFIX}/organizations/${orgId}/members/${vars.orgUserId}`,
          { role: vars.role },
          { activeOrgId: orgId },
        ),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orgMembersKey(orgId) });
      void qc.invalidateQueries({ queryKey: organizationsKey });
    },
  });
}

export function useRemoveMember(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.memberRemove" },
    mutationFn: (orgUserId: string) =>
      apiClient.del(`${ME_PREFIX}/organizations/${orgId}/members/${orgUserId}`, {
        activeOrgId: orgId,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orgMembersKey(orgId) });
      void qc.invalidateQueries({ queryKey: organizationsKey });
    },
  });
}

// ─── Invitations (3c) ─────────────────────────────────────────────────────────

export function useOrgInvitations(orgId: string | null) {
  return useQuery<OrgInvitation[]>({
    queryKey: orgInvitationsKey(orgId ?? ""),
    enabled: !!orgId,
    queryFn: async () =>
      OrganizationInvitationsResponseSchema.parse(
        await apiClient.getRaw<unknown>(
          `${ME_PREFIX}/organizations/${orgId}/invitations`,
          undefined,
          {
            activeOrgId: orgId,
          },
        ),
      ).results,
  });
}

export function useCreateInvitation(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    // The invite form renders the error inline.
    meta: { suppressErrorToast: true },
    mutationFn: async (vars: { email: string; role: "admin" | "member" }) =>
      OrganizationInvitationResponseSchema.parse(
        await apiClient.postRaw<unknown>(`${ME_PREFIX}/organizations/${orgId}/invitations`, vars, {
          activeOrgId: orgId,
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: orgInvitationsKey(orgId) }),
  });
}

export function useCancelInvitation(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.invitationCancel" },
    mutationFn: (invitationId: string) =>
      apiClient.del(`${ME_PREFIX}/organizations/${orgId}/invitations/${invitationId}`, {
        activeOrgId: orgId,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: orgInvitationsKey(orgId) }),
  });
}

/** Invitee-facing: fetch invitation detail for the accept page. Org-agnostic
 *  (`activeOrgId: null`) — the invitee isn't a member of the target org yet. */
export function useInvitation(id: string | null) {
  return useQuery<InvitationDetail>({
    queryKey: invitationKey(id ?? ""),
    enabled: !!id,
    retry: false,
    queryFn: async () =>
      InvitationDetailResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/invitations/${id}`, undefined, {
          activeOrgId: null,
        }),
      ),
  });
}

export function useAcceptInvitation() {
  const qc = useQueryClient();
  const { switchOrg } = usePorts().auth;
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: async (id: string) =>
      AcceptInvitationResponseSchema.parse(
        await apiClient.postRaw<unknown>(
          `${ME_PREFIX}/invitations/${id}/accept`,
          {},
          { activeOrgId: null },
        ),
      ),
    onSuccess: ({ orgId }) => {
      // Join landed — refresh the organization list and switch into the new one.
      void qc.invalidateQueries({ queryKey: organizationsKey });
      switchOrg(orgId);
    },
  });
}
