"use client";

import type { SyncWriteEnvelope } from "@prismical/api-contracts/apps/v1";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient, ME_PREFIX } from "../client";
import { toVocabulary, type CoreVocabulary } from "../adapters";
import type { VocabularyEntry } from "@prismical/app-contracts";

export const vocabularyKey = ["vocabulary"] as const;

export function useVocabulary() {
  return useQuery<VocabularyEntry[]>({
    queryKey: vocabularyKey,
    queryFn: async () =>
      (await apiClient.list<CoreVocabulary>(`${ME_PREFIX}/vocabulary`)).map(toVocabulary),
  });
}

export interface VocabWrite {
  word: string;
  replacementWord?: string | null;
  isReplacement?: boolean;
}

export function useAddVocabulary() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.vocabularyAdd" },
    mutationFn: (v: VocabWrite) =>
      apiClient
        .post<SyncWriteEnvelope<unknown>>(`${ME_PREFIX}/vocabulary`, v)
        .then((response) => response.result),
    onSuccess: () => qc.invalidateQueries({ queryKey: vocabularyKey }),
  });
}

export function useUpdateVocabulary() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.vocabularySave" },
    mutationFn: ({ id, patch }: { id: string; patch: VocabWrite }) =>
      apiClient
        .put<SyncWriteEnvelope<unknown>>(`${ME_PREFIX}/vocabulary/${id}`, patch)
        .then((response) => response.result),
    onSuccess: () => qc.invalidateQueries({ queryKey: vocabularyKey }),
  });
}

export function useDeleteVocabulary() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.vocabularyDelete" },
    mutationFn: (id: string) => apiClient.del(`${ME_PREFIX}/vocabulary/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: vocabularyKey }),
  });
}

// ─── Team vocabulary (org-broadcast, admin-managed) ─────────────────────────────
//
// Peer to the personal lane above, against `/me/team-vocabulary`. READ is
// org-broadcast — every member sees the org's words, which is the point: they apply to everyone's
// transcription. WRITE is admin-gated server-side; the UI hides the controls for non-admins, but
// the 403 is the real boundary.

export const teamVocabularyKey = ["team-vocabulary"] as const;

export function useTeamVocabulary() {
  return useQuery<VocabularyEntry[]>({
    queryKey: teamVocabularyKey,
    queryFn: async () =>
      (await apiClient.list<CoreVocabulary>(`${ME_PREFIX}/team-vocabulary`)).map(toVocabulary),
  });
}

export function useAddTeamVocabulary() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.vocabularyAdd" },
    mutationFn: (v: VocabWrite) =>
      apiClient
        .post<SyncWriteEnvelope<unknown>>(`${ME_PREFIX}/team-vocabulary`, v)
        .then((response) => response.result),
    onSuccess: () => qc.invalidateQueries({ queryKey: teamVocabularyKey }),
  });
}

export function useUpdateTeamVocabulary() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.vocabularySave" },
    mutationFn: ({ id, patch }: { id: string; patch: VocabWrite }) =>
      apiClient
        .put<SyncWriteEnvelope<unknown>>(`${ME_PREFIX}/team-vocabulary/${id}`, patch)
        .then((response) => response.result),
    onSuccess: () => qc.invalidateQueries({ queryKey: teamVocabularyKey }),
  });
}

export function useDeleteTeamVocabulary() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.vocabularyDelete" },
    mutationFn: (id: string) => apiClient.del(`${ME_PREFIX}/team-vocabulary/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: teamVocabularyKey }),
  });
}
