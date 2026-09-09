"use client";

import { useMutation } from "@tanstack/react-query";
import {
  PendingSkillResultsSchema,
  TitleRunResultSchema,
  AcceptSkillRunResponseSchema,
  EnhancedRecordingsResponseSchema,
  RestoreSkillRunResponseSchema,
  RunSkillResultSchema,
  type AcceptSkillRunRequest,
  type AcceptSkillRunResult,
  type RestoreSkillRunResult,
  type RunSkillRequest,
  type RunSkillResult,
} from "@prismical/api-contracts/apps/v1";
import { apiClient, ME_PREFIX } from "../client";

export type { RunUsage } from "@prismical/api-contracts/apps/v1";

// Wire contracts for the cloud skill-execution endpoints.

export type RunResult = RunSkillResult;
export type RunSkillBody = RunSkillRequest;

/** Low-level run call with abort support (the Stop button cancels the billable request). */
export function runSkillRequest(
  skillId: string,
  body: RunSkillBody,
  signal?: AbortSignal,
  onResponse?: (requestId: string | null) => void,
): Promise<RunResult> {
  return apiClient
    .post<unknown>(`${ME_PREFIX}/skills/${skillId}/run`, body, { signal, onResponse })
    .then((response) => RunSkillResultSchema.parse(response));
}

export type AcceptArtifactBody = AcceptSkillRunRequest;
export type AcceptResult = AcceptSkillRunResult;

export function useAcceptArtifact() {
  return useMutation({
    // The diff dock bar wraps mutateAsync in try/catch and toasts itself.
    meta: { suppressErrorToast: true },
    mutationFn: async (body: AcceptArtifactBody) =>
      AcceptSkillRunResponseSchema.parse(
        await apiClient.postRaw<unknown>(`${ME_PREFIX}/skill-runs/accept`, body),
      ),
  });
}

/** Result of POST /me/skill-runs/restore — the undone artifact and the body to re-apply. */
export type RestoreResult = RestoreSkillRunResult;

/** Undo the note's most recent accepted skill run server-side (soft-delete + return the prior body).
 * The caller applies `prevContent` to the editor. */
export function restoreLastSkillRun(noteId: string): Promise<RestoreResult> {
  return apiClient
    .postRaw<unknown>(`${ME_PREFIX}/skill-runs/restore`, { noteId })
    .then((response) => RestoreSkillRunResponseSchema.parse(response));
}

/** IDs of a note's recordings already folded in via a kept Enhance artifact. */
export function listEnhancedRecordingIds(noteId: string): Promise<string[]> {
  return apiClient
    .getRaw<unknown>(`${ME_PREFIX}/enhanced-recordings`, { noteId })
    .then((response) => EnhancedRecordingsResponseSchema.parse(response).recordingIds);
}

export function mutateTitleRun(action: "apply" | "undo", runId: string) {
  return apiClient
    .post<unknown>(`${ME_PREFIX}/title-runs/${action}`, { runId })
    .then((result) => TitleRunResultSchema.parse(result));
}

export async function listPendingSkillResults(noteId: string, signal?: AbortSignal) {
  return PendingSkillResultsSchema.parse(
    await apiClient.getRaw<unknown>(`${ME_PREFIX}/skill-runs/pending`, { noteId }, { signal }),
  ).results;
}
export async function resolvePendingSkillResult(noteId: string, resultId: string, rawMarkdown: string) {
  await apiClient.postRaw(`${ME_PREFIX}/skill-runs/resolve`, { noteId, resultId, rawMarkdown });
}
