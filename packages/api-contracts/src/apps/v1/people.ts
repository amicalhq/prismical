import { z } from 'zod';
import { AppsV1IsoDateTimeSchema } from './common.js';

export const DirectoryListQuerySchema = z.object({
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const PeopleListQuerySchema = DirectoryListQuerySchema.extend({
  internal: z.enum(['true', 'false']).optional(),
});
export const DirectoryIdParamsSchema = z.object({ id: z.string().min(1) });

export const DirectoryCompanyRefSchema = z
  .object({ id: z.string().min(1), name: z.string(), domain: z.string() })
  .strip();
export type DirectoryCompanyRef = z.output<typeof DirectoryCompanyRefSchema>;

export const DirectoryPersonSchema = z
  .object({
    id: z.string().min(1),
    email: z.string(),
    name: z.string().nullable(),
    isInternal: z.boolean(),
    company: DirectoryCompanyRefSchema.nullable(),
    meetingCount: z.number().int().nonnegative(),
    lastMetAt: AppsV1IsoDateTimeSchema.nullable(),
  })
  .strip();
export type DirectoryPerson = z.output<typeof DirectoryPersonSchema>;

export const DirectoryCompanySchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    domain: z.string(),
    avatarUrl: z.string().nullable(),
    peopleCount: z.number().int().nonnegative(),
    meetingCount: z.number().int().nonnegative(),
    lastMetAt: AppsV1IsoDateTimeSchema.nullable(),
  })
  .strip();
export type DirectoryCompany = z.output<typeof DirectoryCompanySchema>;

export const DirectoryMeetingSchema = z
  .object({
    eventId: z.string().min(1),
    title: z.string(),
    startsAt: AppsV1IsoDateTimeSchema.nullable(),
    role: z.string(),
    responseStatus: z.string().nullable(),
    noteId: z.string().nullable(),
    recordingCount: z.number().int().nonnegative(),
  })
  .strip();
export type DirectoryMeeting = z.output<typeof DirectoryMeetingSchema>;

// `hasMore` lets an infinite-scroll client decide whether to request the next offset without a
// separate count query.
//
// It is OPTIONAL with a `false` default, and that is load-bearing: apps/web auto-deploys on push to
// main while apps/core is deployed by hand, so a new client WILL talk to an older core for a while.
// A required field would make that window a hard ZodError -- the whole directory failing rather
// than simply not paginating -- and a shipped desktop build would be stuck on it far longer.
export const PeopleListResultSchema = z
  .object({
    results: z.array(DirectoryPersonSchema),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    hasMore: z.boolean().optional().default(false),
  })
  .strip();
export type PeopleListResult = z.output<typeof PeopleListResultSchema>;
export const PeopleListResponseSchema = PeopleListResultSchema;

export const PersonDetailSchema = z
  .object({
    person: DirectoryPersonSchema.omit({ meetingCount: true, lastMetAt: true }),
    meetings: z.array(DirectoryMeetingSchema),
    /** True when the meeting history was capped, so the UI can say it is showing only the newest. */
    hasMore: z.boolean().optional().default(false),
  })
  .strip();
export type PersonDetail = z.output<typeof PersonDetailSchema>;
export const PersonDetailResponseSchema = PersonDetailSchema;

export const CompaniesListResultSchema = z
  .object({
    results: z.array(DirectoryCompanySchema),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    hasMore: z.boolean().optional().default(false),
  })
  .strip();
export type CompaniesListResult = z.output<typeof CompaniesListResultSchema>;
export const CompaniesListResponseSchema = CompaniesListResultSchema;

export const CompanyDetailSchema = z
  .object({
    company: DirectoryCompanySchema.pick({
      id: true,
      name: true,
      domain: true,
      avatarUrl: true,
    }),
    people: z.array(DirectoryPersonSchema),
    hasMore: z.boolean().optional().default(false),
  })
  .strip();
export type CompanyDetail = z.output<typeof CompanyDetailSchema>;
export const CompanyDetailResponseSchema = CompanyDetailSchema;
