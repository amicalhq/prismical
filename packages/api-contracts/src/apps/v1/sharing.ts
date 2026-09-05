import { z } from 'zod';
import { AppsV1DateTimeResponseSchema, appsV1ListResponseSchema } from './common.js';

export const ShareRoleSchema = z.enum(['viewer', 'editor', 'manager']);
export type ShareRole = z.output<typeof ShareRoleSchema>;
export const SharedResourceTypeSchema = z.enum(['note', 'folder']);
export type SharedResourceType = z.output<typeof SharedResourceTypeSchema>;

export const NoteIdParamsSchema = z.object({ noteId: z.string().min(1) });
export const FolderIdParamsSchema = z.object({ folderId: z.string().min(1) });
export const ShareInvitationParamsSchema = z.object({ invitationId: z.string().min(1) });

export const ShareMemberInputSchema = z.union([
  z.string().transform(orgUserId => ({
    orgUserId,
    permissions: undefined as string[] | undefined,
  })),
  z.object({
    orgUserId: z.string(),
    permissions: z.array(z.enum(['read', 'write', 'share', 'manage'])).optional(),
  }),
]);

export const UpdateResourceShareRequestSchema = z.object({
  add: z.array(ShareMemberInputSchema).optional().default([]),
  remove: z.array(z.string()).optional().default([]),
});

export const CreateShareInvitationRequestSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role: ShareRoleSchema,
});

export const SharedFolderDetailSchema = z
  .object({ id: z.string().min(1), name: z.string(), iconUrl: z.string().nullable() })
  .strip();

export const NoteCreatorSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
  })
  .strip();

export const NoteEventDetailSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    description: z.string().nullable(),
    extId: z.string(),
    calendarName: z.string(),
  })
  .strip();

export const NoteDetailSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    iconUrl: z.string().nullable(),
    folderId: z.string().nullable(),
    folder: SharedFolderDetailSchema.nullable(),
    creator: NoteCreatorSchema,
    event: NoteEventDetailSchema.nullable(),
    createdAt: AppsV1DateTimeResponseSchema,
    updatedAt: AppsV1DateTimeResponseSchema,
  })
  .strip();
export type NoteDetail = z.output<typeof NoteDetailSchema>;
export const NoteDetailResponseSchema = NoteDetailSchema;

export const FolderDetailSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    iconUrl: z.string().nullable(),
    orgId: z.string().min(1),
    meta: z.unknown(),
    memberCount: z.number().int().nonnegative(),
    createdAt: AppsV1DateTimeResponseSchema,
    updatedAt: AppsV1DateTimeResponseSchema,
  })
  .strip();
export type FolderDetail = z.output<typeof FolderDetailSchema>;
export const FolderDetailResponseSchema = FolderDetailSchema;

export const ShareOwnerSchema = z
  .object({
    orgUserId: z.string().min(1),
    userId: z.string().min(1),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    role: z.literal('owner'),
    isSelf: z.boolean(),
  })
  .strip();
export type ShareOwner = z.output<typeof ShareOwnerSchema>;

export const ShareMemberSchema = z
  .object({
    orgUserId: z.string().min(1),
    userId: z.string().min(1),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    permissions: z.array(z.string()),
    role: ShareRoleSchema,
    isSelf: z.boolean(),
  })
  .strip();
export type ShareMember = z.output<typeof ShareMemberSchema>;

export const NoteMembersResponseSchema = z
  .object({
    noteId: z.string().min(1),
    canManage: z.boolean(),
    owner: ShareOwnerSchema,
    members: z.array(ShareMemberSchema),
    inherited: z.array(ShareMemberSchema.extend({ folderId: z.string().min(1) })),
  })
  .strip();
export type NoteMembersResponse = z.output<typeof NoteMembersResponseSchema>;

export const FolderMembersResponseSchema = z
  .object({
    folderId: z.string().min(1),
    canManage: z.boolean(),
    owner: ShareOwnerSchema,
    members: z.array(ShareMemberSchema),
  })
  .strip();
export type FolderMembersResponse = z.output<typeof FolderMembersResponseSchema>;

export const ShareNoteResponseSchema = z
  .object({
    noteId: z.string().min(1),
    added: z.array(z.string()),
    removed: z.array(z.string()),
  })
  .strip();

export const ShareFolderResponseSchema = z
  .object({
    folderId: z.string().min(1),
    added: z.array(z.string()),
    removed: z.array(z.string()),
  })
  .strip();

export const NotePublicationSchema = z
  .object({ publishedAt: AppsV1DateTimeResponseSchema.nullable() })
  .strip();
export type NotePublication = z.output<typeof NotePublicationSchema>;
export const NotePublicationResponseSchema = NotePublicationSchema;
export const NotePublicationStateResponseSchema = NotePublicationSchema.extend({
  allowPublicSharing: z.boolean(),
});
export type NotePublicationStateResponse = z.output<typeof NotePublicationStateResponseSchema>;

export const ResourceInvitationSchema = z
  .object({
    id: z.string().min(1),
    email: z.string(),
    role: ShareRoleSchema,
    status: z.string(),
    expiresAt: AppsV1DateTimeResponseSchema,
  })
  .strip();
export type ResourceInvitation = z.output<typeof ResourceInvitationSchema>;

export const CreatedResourceInvitationSchema = ResourceInvitationSchema.extend({
  resourceType: SharedResourceTypeSchema,
  resourceId: z.string().min(1),
});
export const ResourceInvitationResponseSchema = CreatedResourceInvitationSchema;
export const ResourceInvitationsResponseSchema = appsV1ListResponseSchema(ResourceInvitationSchema);

export const RevokedShareInvitationResponseSchema = z.object({ revoked: z.boolean() }).strip();

export const ShareInvitationDetailSchema = z
  .object({
    resourceType: SharedResourceTypeSchema,
    resourceTitle: z.string(),
    role: ShareRoleSchema,
    inviterName: z.string(),
    email: z.string(),
    canAccept: z.boolean(),
    reason: z
      .enum(['wrong-account', 'already-accepted', 'revoked', 'expired', 'unavailable'])
      .nullable()
      .optional(),
  })
  .strip();
export type ShareInvitationDetail = z.output<typeof ShareInvitationDetailSchema>;
export const ShareInvitationDetailResponseSchema = ShareInvitationDetailSchema;

export const AcceptShareInvitationSchema = z
  .object({ resourceType: SharedResourceTypeSchema, resourceId: z.string().min(1) })
  .strip();
export const AcceptShareInvitationResponseSchema = AcceptShareInvitationSchema;
