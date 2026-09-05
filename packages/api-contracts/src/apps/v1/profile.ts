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
