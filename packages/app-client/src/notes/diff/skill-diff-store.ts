import { create } from "zustand";
import type { JSONContent } from "@tiptap/core";
import type { ArtifactMode } from "@prismical/app-contracts";
import type { AcceptSkillRunResult } from "@prismical/api-contracts/apps/v1";
import type { SelectionAnchors } from "./selection-anchors";

// A staged skill-run result awaiting Accept/Refine/Reject. Mirrors the desktop SkillDiffCandidate,
// minus the desktop-local provider fields (modelInstanceId/providerType). noteId is the cloud
// string id. Inline-rewrite anchors the target range with Yjs relative positions (NOT the
// desktop's raw {from,to} — see selection-anchors.ts for why).
export interface SkillDiffCandidate {
  /** Page-session workflow and proposal identities used by review commands. */
  workflowId?: string;
  proposalId?: string;
  /** Original body for a replace-doc proposal; applying must reject newer edits. */
  baseContent?: string;
  resultId?: string;
  /** Native recording output that can be recovered after an app restart. */
  recoverable?: boolean;
  /** Reuse a saved artifact when its editor application needs a same-session retry. */
  acceptance?: { result: AcceptSkillRunResult; prevContent?: string; applied?: true };
  noteId: string;
  skillId: string;
  skillName: string;
  /** The recording this candidate was scoped to; forwarded to accept. */
  recordingId?: string;
  mode: ArtifactMode;
  modelId: string;
  /** Audit meta forwarded to POST /me/artifacts on accept. */
  reasoning: string | null;
  refineInstruction: string | null;
  selectionText: string | null;
  /** inline-rewrite only: Yjs relative anchors of the range to replace. */
  selectionAnchors?: SelectionAnchors;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    raw?: string;
  };
  /** The TipTap JSON children produced from the model's markdown. */
  content: JSONContent[];
  rawMarkdown: string;
}

interface SkillDiffState {
  candidatesByNote: Map<string, SkillDiffCandidate>;
  stage: (candidate: SkillDiffCandidate) => void;
  clear: (noteId: string) => void;
  getCandidate: (noteId: string) => SkillDiffCandidate | undefined;
}

// NOTE: there is deliberately NO `switchMode`. Flipping a staged candidate between
// append-section and replace-doc WITHOUT re-running was a data-loss footgun: append content applied
// as a whole-doc replace silently discards the note. The mode is fixed at run time (append vs replace
// produce different output); to change it, re-run — the server picks the right mode via the Enhance
// provenance bias, and restore-last is the safety floor.
export const useSkillDiffStore = create<SkillDiffState>((set, get) => ({
  candidatesByNote: new Map(),

  stage: (candidate) =>
    set((s) => {
      const next = new Map(s.candidatesByNote);
      next.set(candidate.noteId, candidate);
      return { candidatesByNote: next };
    }),

  clear: (noteId) =>
    set((s) => {
      const next = new Map(s.candidatesByNote);
      next.delete(noteId);
      return { candidatesByNote: next };
    }),

  getCandidate: (noteId) => get().candidatesByNote.get(noteId),
}));
