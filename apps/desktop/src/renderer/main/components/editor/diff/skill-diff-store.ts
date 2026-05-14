import { create } from "zustand";
import type { NodeKey, SerializedLexicalNode } from "lexical";
import type { ArtifactMode } from "@/db/schema";

/**
 * Captured selection endpoint at skill-run time. Used for `inline-rewrite`
 * mode so the action bar can restore the original range before dispatching
 * the insert command — by accept-time the live editor selection has moved
 * to the action bar / popover / elsewhere and `$getSelection()` would
 * return a stale or null range.
 */
export interface SerializedSelectionPoint {
  key: NodeKey;
  offset: number;
  type: "text" | "element";
}

export interface SerializedSelectionPoints {
  anchor: SerializedSelectionPoint;
  focus: SerializedSelectionPoint;
}

export interface SkillDiffCandidate {
  noteId: number;
  skillId: string;
  skillName: string;
  mode: ArtifactMode;
  modelId: string;
  /** Audit-meta we pass back to `skillRuns.accept` so it can write the row. */
  modelInstanceId: string;
  providerType: string;
  refineInstruction: string | null;
  selectionText: string | null;
  reasoning: string | null;
  /** For append-section / inline-rewrite: the Lexical children. */
  content: SerializedLexicalNode[];
  rawMarkdown: string;
  /** For replace-doc / inline-rewrite: the "before" text we diff against. */
  beforeText?: string;
  /** Captured for inline-rewrite so accept can restore the selection. */
  selectionPoints?: SerializedSelectionPoints;
}

interface SkillDiffState {
  candidatesByNote: Map<number, SkillDiffCandidate>;
  stage: (candidate: SkillDiffCandidate) => void;
  clear: (noteId: number) => void;
  getCandidate: (noteId: number) => SkillDiffCandidate | undefined;
  /**
   * Flip a staged candidate between `append-section` and `replace-doc` without
   * re-running the model. The candidate's `rawMarkdown` + `content` are
   * reused as-is (`markdownToChildren` produces block-level Lexical nodes
   * that are valid in both positions); only `mode` changes, and `beforeText`
   * is already populated for both modes by the runner.
   *
   * No-op when called on an `inline-rewrite` run or if no candidate is
   * staged. Refine after a switch picks up the switched mode automatically
   * because the action bar passes `candidate.mode` into the run call.
   */
  switchMode: (noteId: number) => void;
}

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

  switchMode: (noteId) =>
    set((s) => {
      const current = s.candidatesByNote.get(noteId);
      if (!current) return s;
      if (current.mode !== "append-section" && current.mode !== "replace-doc") {
        return s;
      }
      const next = new Map(s.candidatesByNote);
      next.set(noteId, {
        ...current,
        mode:
          current.mode === "append-section" ? "replace-doc" : "append-section",
      });
      return { candidatesByNote: next };
    }),
}));
