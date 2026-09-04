"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient, ME_PREFIX } from "../client";
import { toSkill, type CoreSkill } from "../adapters";
import type { Skill, SkillConfig } from "@prismical/app-contracts";

export const skillsKey = ["skills"] as const;

export function useSkillsList() {
  return useQuery<Skill[]>({
    queryKey: skillsKey,
    queryFn: async () =>
      (await apiClient.list<CoreSkill>(`${ME_PREFIX}/skills`)).map((s) => toSkill(s, s.enabled ?? true)),
  });
}

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  config: SkillConfig;
  enabled?: boolean;
  /** MCP tool grants — passes through the sync lane to skill.allowed_tools. */
  allowedTools?: string[] | null;
}

export function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation({
    // skill-form / skills page catch and render these inline.
    meta: { suppressErrorToast: true },
    mutationFn: (draft: SkillDraft) => apiClient.post<CoreSkill>(`${ME_PREFIX}/skills`, draft),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillsKey }),
  });
}

export function useUpdateSkill() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: ({ id, patch }: { id: string; patch: Partial<SkillDraft> }) =>
      apiClient.put<CoreSkill>(`${ME_PREFIX}/skills/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillsKey }),
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    // skill-form catches and renders this inline.
    meta: { suppressErrorToast: true },
    mutationFn: (id: string) => apiClient.del(`${ME_PREFIX}/skills/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillsKey }),
  });
}
