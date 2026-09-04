import { z } from 'zod';
import { AppsV1IsoDateTimeSchema, appsV1ResultResponseSchema } from './common.js';

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

export const PeopleListResultSchema = z
  .object({
    people: z.array(DirectoryPersonSchema),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  })
  .strip();
export type PeopleListResult = z.output<typeof PeopleListResultSchema>;
export const PeopleListResponseSchema = appsV1ResultResponseSchema(PeopleListResultSchema);

export const PersonDetailSchema = z
  .object({
    person: DirectoryPersonSchema.omit({ meetingCount: true, lastMetAt: true }),
    meetings: z.array(DirectoryMeetingSchema),
  })
  .strip();
export type PersonDetail = z.output<typeof PersonDetailSchema>;
export const PersonDetailResponseSchema = appsV1ResultResponseSchema(PersonDetailSchema);

export const CompaniesListResultSchema = z
  .object({
    companies: z.array(DirectoryCompanySchema),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  })
  .strip();
export type CompaniesListResult = z.output<typeof CompaniesListResultSchema>;
export const CompaniesListResponseSchema = appsV1ResultResponseSchema(CompaniesListResultSchema);

export const CompanyDetailSchema = z
  .object({
    company: DirectoryCompanySchema.pick({
      id: true,
      name: true,
      domain: true,
      avatarUrl: true,
    }),
    people: z.array(DirectoryPersonSchema),
  })
  .strip();
export type CompanyDetail = z.output<typeof CompanyDetailSchema>;
export const CompanyDetailResponseSchema = appsV1ResultResponseSchema(CompanyDetailSchema);
