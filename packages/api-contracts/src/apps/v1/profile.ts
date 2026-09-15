import { z } from 'zod';

export const ViewerProfileSchema = z
  .object({
    id: z.string().min(1),
    email: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
  })
  .strip();
export type ViewerProfile = z.output<typeof ViewerProfileSchema>;
export const ViewerProfileResponseSchema = ViewerProfileSchema;

/** Bounded raster uploads only; external provider images remain read-only. */
export const UpdateViewerProfileRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    image: z
      .string()
      .max(180_000)
      .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/)
      .nullable()
      .optional(),
  })
  .strict();
export const AccountSecurityResponseSchema = z.object({
  requiresSignIn: z.boolean(),
  hasPassword: z.boolean(),
  providers: z.array(
    z.object({
      id: z.enum(['google', 'apple']),
      enabled: z.boolean(),
      accounts: z.array(z.object({ id: z.string() })),
    })
  ),
});
export type AccountSecurity = z.infer<typeof AccountSecurityResponseSchema>;
export const AccountSecurityActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('password'),
      currentPassword: z.string().min(1).max(128),
      newPassword: z.string().min(8).max(128),
    })
    .strict(),
  z.object({ action: z.literal('link'), provider: z.enum(['google', 'apple']) }).strict(),
  z.object({ action: z.literal('unlink'), accountId: z.string().min(1).max(255) }).strict(),
]);
export type AccountSecurityAction = z.infer<typeof AccountSecurityActionSchema>;
export const AccountSecurityActionResponseSchema = z.object({ url: z.string().url().optional() });
