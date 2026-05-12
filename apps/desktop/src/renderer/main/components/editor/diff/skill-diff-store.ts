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
  artifactId: string;
  skillId: string;
  skillName: string;
  mode: ArtifactMode;
  version: number;
  generatedAt: string;
  modelId: string;
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
}));
