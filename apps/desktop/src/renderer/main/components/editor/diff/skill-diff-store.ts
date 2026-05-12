import { create } from "zustand";
import type { SerializedLexicalNode } from "lexical";
import type { ArtifactMode } from "@/db/schema";

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
  /** For replace-doc and inline-rewrite: the "before" text we diff against. */
  beforeText?: string;
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
