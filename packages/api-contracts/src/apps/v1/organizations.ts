import { z } from 'zod';
import {
  AppsV1DateTimeResponseSchema,
  appsV1ResultEnvelopeSchema,
  appsV1ResultsEnvelopeSchema,
} from './common.js';

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
  })
  .strip();
export type Organization = z.output<typeof OrganizationSchema>;
export const OrganizationsResponseSchema = appsV1ResultsEnvelopeSchema(OrganizationSchema);
export const OrganizationResponseSchema = appsV1ResultEnvelopeSchema(OrganizationSchema);

export const RenamedOrganizationSchema = z
  .object({ orgId: z.string().min(1), name: z.string(), slug: z.string() })
  .strip();
export const RenamedOrganizationResponseSchema =
  appsV1ResultEnvelopeSchema(RenamedOrganizationSchema);

export const OrganizationSharingPolicySchema = z
  .object({ orgId: z.string().min(1), allowPublicSharing: z.boolean() })
  .strip();
export const OrganizationSharingPolicyResponseSchema = appsV1ResultEnvelopeSchema(
  OrganizationSharingPolicySchema
);

export const RevokedPublicLinksSchema = z
  .object({ revoked: z.number().int().nonnegative() })
  .strip();
export const RevokedPublicLinksResponseSchema =
  appsV1ResultEnvelopeSchema(RevokedPublicLinksSchema);

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
export const OrganizationMembersResponseSchema =
  appsV1ResultsEnvelopeSchema(OrganizationMemberSchema);

export const UpdatedOrganizationMemberSchema = z
  .object({
    orgUserId: z.string().min(1),
    userId: z.string().min(1),
    role: OrganizationRoleSchema,
    isSelf: z.boolean(),
  })
  .strip();
export const UpdatedOrganizationMemberResponseSchema = appsV1ResultEnvelopeSchema(
  UpdatedOrganizationMemberSchema
);

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
export const OrganizationInvitationsResponseSchema = appsV1ResultsEnvelopeSchema(
  OrganizationInvitationSchema
);
export const OrganizationInvitationResponseSchema = appsV1ResultEnvelopeSchema(
  OrganizationInvitationSchema
);

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
export const InvitationDetailResponseSchema = appsV1ResultEnvelopeSchema(InvitationDetailSchema);

export const AcceptInvitationResultSchema = z
  .object({ orgId: z.string().min(1), role: OrganizationRoleSchema })
  .strip();
export const AcceptInvitationResponseSchema = appsV1ResultEnvelopeSchema(
  AcceptInvitationResultSchema
);
