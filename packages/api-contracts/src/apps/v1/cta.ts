import { z } from 'zod';

const httpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Use an HTTPS URL without credentials');

/** Content only: campaign selection and user state are resolved by the server. */
export const CtaContentSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(2000),
    icon: z.enum(['gift', 'megaphone', 'star', 'sparkles', 'heart']).default('megaphone'),
    headerGradient: z.enum(['indigo', 'purple', 'pink', 'blue_green']).nullable().optional(),
    iconGradient: z.enum(['indigo', 'purple', 'pink', 'blue_green']).nullable().optional(),
    buttonGradient: z.enum(['indigo', 'purple', 'pink', 'blue_green']).nullable().optional(),
    headerColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .optional(),
    iconColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .optional(),
    buttonColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .default(null),
    imageUrl: httpsUrl.nullable().default(null),
    delaySeconds: z.number().int().min(0).max(3600).default(5),
    card: z.boolean().default(true),
    sidebar: z.boolean().default(true),
    sidebarLabel: z.string().trim().min(1).max(80),
    dismissLabel: z.string().trim().min(1).max(80).default('Dismiss'),
    sidebarAction: z.enum(['open_card', 'open_url']).default('open_card'),
    action: z.object({
      type: z.literal('open_url'),
      label: z.string().trim().min(1).max(80),
      url: httpsUrl,
    }),
  })
  .refine(value => value.card || value.sidebar, 'Choose at least one placement');

export const CtaSchema = z.object({
  id: z.string().min(1),
  campaignKey: z.string().min(1),
  assignmentId: z.string().min(1),
  dismissed: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
  content: CtaContentSchema,
});
export const CtaDismissParamsSchema = z.object({ assignmentId: z.string().min(1).max(200) });
export const CtaDismissResponseSchema = z.object({ dismissed: z.literal(true) });
export type Cta = z.output<typeof CtaSchema>;
export type CtaContent = z.output<typeof CtaContentSchema>;
