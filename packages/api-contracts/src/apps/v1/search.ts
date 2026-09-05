import { z } from 'zod';
import { AppsV1DateTimeResponseSchema } from './common.js';

export const SearchRequestSchema = z.object({
  query: z.string().min(1, 'Search query must not be empty').max(500, 'Search query too long'),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
  offset: z.coerce.number().min(0).optional().default(0),
});
export type SearchRequest = z.input<typeof SearchRequestSchema>;
export type ParsedSearchRequest = z.output<typeof SearchRequestSchema>;

export const SearchHitSchema = z
  .object({
    id: z.string().min(1),
    noteId: z.string().min(1),
    title: z.string(),
    contentText: z.string(),
    createdAt: AppsV1DateTimeResponseSchema,
    updatedAt: AppsV1DateTimeResponseSchema,
  })
  .strip();
export type SearchHit = z.output<typeof SearchHitSchema>;

export const SearchResponseSchema = z
  .object({
    results: z.array(SearchHitSchema),
    total: z.number().int().nonnegative(),
    query: z.string(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  })
  .strip();
