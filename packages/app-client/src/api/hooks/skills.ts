"use client";

import type { SyncWriteEnvelope } from "@prismical/api-contracts/apps/v1";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { apiClient, ME_PREFIX } from "../client";
import { toSkill, type CoreSkill } from "../adapters";
import { NAME_NOTE_SKILL_ID, type Skill, type SkillConfig } from "@prismical/app-contracts";
import { useFeatureFlag } from "./organizations";

export const skillsKey = ["skills"] as const;

/**
 * Every skill the caller may use, with feature-gated system skills removed.
 *
 * Core is the authority — it withholds the row and refuses to run it — so this is belt and
 * braces for the window where a client's cached list is ahead of its cached flags, and insurance
 * against a server that regresses. Applied through `select` rather than in the query function so
 * the cached payload stays whatever the server sent: a flag flip re-derives the list without a
 * refetch, and the loading/error state every caller reads is untouched.
 *
 * Note the asymmetry this creates on OPT-IN: the org list `useFeatureFlags` reads caches for five
 * minutes while this list caches for thirty seconds, so an org merged into a rollout can be served
 * the skill and still not see it until its next reload. Turning a feature OFF has no such lag,
 * which is the direction that matters for a gate.
 */
export function useSkillsList() {
  const { enabled: nameNoteEnabled } = useFeatureFlag("nameNoteSkill");
  const select = useCallback(
    (skills: Skill[]) =>
      nameNoteEnabled ? skills : skills.filter((s) => s.id !== NAME_NOTE_SKILL_ID),
    [nameNoteEnabled],
  );
  return useQuery<Skill[], Error, Skill[]>({
    queryKey: skillsKey,
    queryFn: async () =>
      (await apiClient.list<CoreSkill>(`${ME_PREFIX}/skills`)).map((s) => toSkill(s, s.enabled ?? true)),
    select,
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
    mutationFn: (draft: SkillDraft) =>
      apiClient
        .post<SyncWriteEnvelope<CoreSkill>>(`${ME_PREFIX}/skills`, draft)
        .then((response) => response.result),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillsKey }),
  });
}

export function useUpdateSkill() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: ({ id, patch }: { id: string; patch: Partial<SkillDraft> }) =>
      apiClient
        .put<SyncWriteEnvelope<CoreSkill>>(`${ME_PREFIX}/skills/${id}`, patch)
        .then((response) => response.result),
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
