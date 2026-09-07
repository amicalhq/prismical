"use client";

import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from "@tanstack/react-query";
import {
  CompaniesListResponseSchema,
  CompanyDetailResponseSchema,
  PeopleListResponseSchema,
  PersonDetailResponseSchema,
  type CompaniesListResult,
  type CompanyDetail,
  type DirectoryCompany,
  type DirectoryPerson,
  type PeopleListResult,
  type PersonDetail,
} from "@prismical/api-contracts/apps/v1";
import { apiClient, ME_PREFIX, type QueryParams } from "../client";

// ─── Server response shapes for /me/people and /me/companies ───────────────────

export type {
  CompanyDetail,
  DirectoryCompany,
  DirectoryCompanyRef,
  DirectoryMeeting,
  DirectoryPerson,
  PersonDetail,
} from "@prismical/api-contracts/apps/v1";

/** Filter for the People list: all people, external-only, or teammates-only. */
export type PeopleFilter = "all" | "external" | "internal";

/**
 * Rows per request. The directory lists are infinite-scrolled rather than page-numbered — they are
 * scanned and searched, not navigated by index — so this is a fetch size, not a visible page.
 * The server caps `limit` at 100.
 */
export const DIRECTORY_PAGE_SIZE = 50;

/**
 * Next `offset` to request, or undefined when the server said this was the last page. Generic so it
 * does not narrow the inferred page type at the `useInfiniteQuery` call sites below.
 */
const nextOffset = <T extends { hasMore: boolean; limit: number; offset: number }>(last: T) =>
  last.hasMore ? last.offset + last.limit : undefined;

// ─── Hooks ──────────────────────────────────────────────────────────────────

/**
 * People the caller has met, newest meeting first. `data` is the flattened list across every page
 * fetched so far; pull `fetchNextPage` / `hasNextPage` / `isFetchingNextPage` for the scroll sentinel.
 */
export function usePeople(
  opts: { search?: string; filter?: PeopleFilter } = {},
): UseInfiniteQueryResult<DirectoryPerson[], Error> {
  const search = opts.search?.trim() || undefined;
  const filter = opts.filter ?? "all";
  return useInfiniteQuery({
    queryKey: ["people", { search: search ?? "", filter }],
    // Keep the previous results visible while a new search term loads, so the list doesn't flash to
    // the skeleton on each keystroke (search is debounced upstream; this smooths the transition).
    placeholderData: keepPreviousData,
    initialPageParam: 0,
    getNextPageParam: nextOffset,
    select: (data: InfiniteData<PeopleListResult, number>) =>
      data.pages.flatMap((page) => page.results),
    queryFn: ({ pageParam }): Promise<PeopleListResult> => {
      const query: QueryParams = { limit: DIRECTORY_PAGE_SIZE, offset: pageParam };
      if (search) query.search = search;
      if (filter === "external") query.internal = "false";
      if (filter === "internal") query.internal = "true";
      return apiClient
        .getRaw<unknown>(`${ME_PREFIX}/people`, query)
        .then((response) => PeopleListResponseSchema.parse(response));
    },
  });
}

export function usePerson(id: string | undefined) {
  return useQuery<PersonDetail>({
    queryKey: ["person", id],
    enabled: Boolean(id),
    queryFn: async () =>
      PersonDetailResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/people/${id}`),
      ),
  });
}

/** Companies the caller has met people at, newest meeting first. Paged like `usePeople`. */
export function useCompanies(
  opts: { search?: string } = {},
): UseInfiniteQueryResult<DirectoryCompany[], Error> {
  const search = opts.search?.trim() || undefined;
  return useInfiniteQuery({
    queryKey: ["companies", { search: search ?? "" }],
    placeholderData: keepPreviousData,
    initialPageParam: 0,
    getNextPageParam: nextOffset,
    select: (data: InfiniteData<CompaniesListResult, number>) =>
      data.pages.flatMap((page) => page.results),
    queryFn: ({ pageParam }): Promise<CompaniesListResult> => {
      const query: QueryParams = { limit: DIRECTORY_PAGE_SIZE, offset: pageParam };
      if (search) query.search = search;
      return apiClient
        .getRaw<unknown>(`${ME_PREFIX}/companies`, query)
        .then((response) => CompaniesListResponseSchema.parse(response));
    },
  });
}

export function useCompany(id: string | undefined) {
  return useQuery<CompanyDetail>({
    queryKey: ["company", id],
    enabled: Boolean(id),
    queryFn: async () =>
      CompanyDetailResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/companies/${id}`),
      ),
  });
}
