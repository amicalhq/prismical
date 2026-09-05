"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import {
  PlanAccessResponseSchema,
  PlanCheckoutResponseSchema,
  PlanPortalResponseSchema,
  type BillingInterval,
  type PlanAccess,
} from "@prismical/api-contracts/apps/v1";
import { useActiveOrgId } from "../../ports-context";
import { apiClient, ME_PREFIX } from "../client";

export type {
  BillingInterval,
  PlanAccess,
  PlanCatalogEntry,
  PlanInclusions,
} from "@prismical/api-contracts/apps/v1";

export function usePlanAccess() {
  const activeOrgId = useActiveOrgId();
  return useQuery<PlanAccess>({
    queryKey: ["billing-plan", activeOrgId],
    queryFn: async () =>
      PlanAccessResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/plan`, undefined, {
          activeOrgId,
        }),
      ),
  });
}

export function useCreatePlanCheckout() {
  const activeOrgId = useActiveOrgId();
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: async (input: { planExternalId: string; billingInterval: BillingInterval }) =>
      PlanCheckoutResponseSchema.parse(
        await apiClient.postRaw<unknown>(`${ME_PREFIX}/plan/checkout`, input, {
          activeOrgId,
          credentials: true,
        }),
      ),
  });
}

export function useCreateBillingPortal() {
  const activeOrgId = useActiveOrgId();
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: async () =>
      PlanPortalResponseSchema.parse(
        await apiClient.postRaw<unknown>(`${ME_PREFIX}/plan/portal`, undefined, {
          activeOrgId,
          credentials: true,
        }),
      ),
  });
}
