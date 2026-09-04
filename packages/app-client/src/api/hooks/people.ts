"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  CompaniesListResponseSchema,
  CompanyDetailResponseSchema,
  PeopleListResponseSchema,
  PersonDetailResponseSchema,
  type CompaniesListResult,
  type CompanyDetail,
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

// ─── Hooks ──────────────────────────────────────────────────────────────────

export function usePeople(opts: { search?: string; filter?: PeopleFilter } = {}) {
  const search = opts.search?.trim() || undefined;
  const filter = opts.filter ?? "all";
  return useQuery<PeopleListResult>({
    queryKey: ["people", { search: search ?? "", filter }],
    // Keep the previous page visible while a new search term loads, so the list doesn't flash to
    // the skeleton on each keystroke (search is debounced upstream; this smooths the transition).
    placeholderData: keepPreviousData,
    queryFn: () => {
      const query: QueryParams = {};
      if (search) query.search = search;
      if (filter === "external") query.internal = "false";
      if (filter === "internal") query.internal = "true";
      return apiClient
        .getRaw<unknown>(`${ME_PREFIX}/people`, query)
        .then((response) => PeopleListResponseSchema.parse(response).result);
    },
  });
}

export function usePerson(id: string | undefined) {
  return useQuery<PersonDetail>({
    queryKey: ["person", id],
    enabled: Boolean(id),
    queryFn: async () =>
      PersonDetailResponseSchema.parse(await apiClient.getRaw<unknown>(`${ME_PREFIX}/people/${id}`))
        .result,
  });
}

export function useCompanies(opts: { search?: string } = {}) {
  const search = opts.search?.trim() || undefined;
  return useQuery<CompaniesListResult>({
    queryKey: ["companies", { search: search ?? "" }],
    placeholderData: keepPreviousData,
    queryFn: () => {
      const query: QueryParams = {};
      if (search) query.search = search;
      return apiClient
        .getRaw<unknown>(`${ME_PREFIX}/companies`, query)
        .then((response) => CompaniesListResponseSchema.parse(response).result);
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
      ).result,
  });
}
