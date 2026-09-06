import { z } from 'zod';
import { AppsV1DateTimeResponseSchema, appsV1ListResponseSchema } from './common.js';
import { PlanEntitlementsSchema } from './plan.js';

export const OrganizationRoleSchema = z.enum(['owner', 'admin', 'member']);
export const OrganizationInviteRoleSchema = z.enum(['admin', 'member']);
export type OrganizationRole = z.output<typeof OrganizationRoleSchema>;

export const OrganizationParamsSchema = z.object({ orgId: z.string().min(1) });
export const OrganizationMemberParamsSchema = z.object({
  orgId: z.string().min(1),
  orgUserId: z.string().min(1),
});
export const OrganizationInvitationParamsSchema = z.object({
  orgId: z.string().min(1),
  invitationId: z.string().min(1),
});
export const InvitationParamsSchema = z.object({ invitationId: z.string().min(1) });

export const OrganizationNameRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
});
export const OrganizationSharingPolicyRequestSchema = z.object({
  allowPublicSharing: z.boolean(),
});
export const OrganizationMemberRoleRequestSchema = z.object({ role: OrganizationRoleSchema });
export const CreateOrganizationInvitationRequestSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role: OrganizationInviteRoleSchema,
});

export const OrganizationTranscriptionPolicySchema = z
  .object({
    autoPauseSilenceSeconds: z.number().nonnegative().optional(),
    autoPauseGraceSeconds: z.number().nonnegative().optional(),
    autoStopAfterPausedMinutes: z.number().nonnegative().optional(),
  })
  .strip();

export const OrganizationSchema = z
  .object({
    orgUserId: z.string().min(1),
    orgId: z.string().min(1),
    name: z.string(),
    slug: z.string(),
    role: OrganizationRoleSchema,
    allowPublicSharing: z.boolean(),
    features: z.record(z.string(), z.boolean()),
    transcription: OrganizationTranscriptionPolicySchema.optional(),
    memberCount: z.number().int().nonnegative(),
    /**
     * What the org's plan grants (Ask AI, BYOK, automations, floating mode, recording length,
     * seats, credits). Read through `useEntitlements()` on the client; optional only so a client
     * can parse a core that predates entitlements — absent means "no plan gate", never "off".
     */
    entitlements: PlanEntitlementsSchema.optional(),
  })
  .strip();
export type Organization = z.output<typeof OrganizationSchema>;
export const OrganizationsResponseSchema = appsV1ListResponseSchema(OrganizationSchema);
export const OrganizationResponseSchema = OrganizationSchema;

export const RenamedOrganizationSchema = z
  .object({ orgId: z.string().min(1), name: z.string(), slug: z.string() })
  .strip();
export const RenamedOrganizationResponseSchema = RenamedOrganizationSchema;

export const OrganizationSharingPolicySchema = z
  .object({ orgId: z.string().min(1), allowPublicSharing: z.boolean() })
  .strip();
export const OrganizationSharingPolicyResponseSchema = OrganizationSharingPolicySchema;

export const RevokedPublicLinksSchema = z
  .object({ revoked: z.number().int().nonnegative() })
  .strip();
export const RevokedPublicLinksResponseSchema = RevokedPublicLinksSchema;

export const OrganizationMemberSchema = z
  .object({
    orgUserId: z.string().min(1),
    userId: z.string().min(1),
    name: z.string().nullable(),
    email: z.string(),
    image: z.string().nullable(),
    role: OrganizationRoleSchema,
    isSelf: z.boolean(),
  })
  .strip();
export type OrganizationMember = z.output<typeof OrganizationMemberSchema>;
export const OrganizationMembersResponseSchema = appsV1ListResponseSchema(OrganizationMemberSchema);

export const UpdatedOrganizationMemberSchema = z
  .object({
    orgUserId: z.string().min(1),
    userId: z.string().min(1),
    role: OrganizationRoleSchema,
    isSelf: z.boolean(),
  })
  .strip();
export const UpdatedOrganizationMemberResponseSchema = UpdatedOrganizationMemberSchema;

export const OrganizationInvitationSchema = z
  .object({
    id: z.string().min(1),
    email: z.string(),
    role: OrganizationRoleSchema,
    status: z.string(),
    expiresAt: AppsV1DateTimeResponseSchema,
    createdAt: AppsV1DateTimeResponseSchema,
  })
  .strip();
export type OrganizationInvitation = z.output<typeof OrganizationInvitationSchema>;
export const OrganizationInvitationsResponseSchema = appsV1ListResponseSchema(
  OrganizationInvitationSchema
);
export const OrganizationInvitationResponseSchema = OrganizationInvitationSchema;

export const InvitationDetailSchema = z
  .object({
    id: z.string().min(1),
    email: z.string(),
    role: OrganizationRoleSchema,
    status: z.string(),
    expiresAt: AppsV1DateTimeResponseSchema,
    organizationId: z.string().min(1),
    organizationName: z.string(),
    inviterName: z.string().nullable(),
    canAccept: z.boolean(),
    reason: z.enum(['wrong-account', 'already-accepted', 'canceled', 'expired']).optional(),
  })
  .strip();
export type InvitationDetail = z.output<typeof InvitationDetailSchema>;
export const InvitationDetailResponseSchema = InvitationDetailSchema;

export const AcceptInvitationResultSchema = z
  .object({ orgId: z.string().min(1), role: OrganizationRoleSchema })
  .strip();
export const AcceptInvitationResponseSchema = AcceptInvitationResultSchema;
