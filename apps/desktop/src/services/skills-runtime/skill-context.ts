import type { ArtifactMode, Skill } from "@/db/schema";
import type { SerializedLexicalNode } from "lexical";

// The runtime is stateless per call. All inputs the runner needs are bound
// into this context object once. The runner deterministically gathers
// note/transcript/selection from these — the model never picks what to read.
export interface SkillRunContext {
  // The skill being run. Loaded once via SkillsService.getBySlug.
  skill: Skill;

  // The note this run targets. Used by collectInput + the audit write path.
  noteId: number;

  // Active mode for this run — equals skill.config.editingOptions unless the
  // user overrode via the picker's `⋯` menu (Plan 5).
  mode: ArtifactMode;

  // Optional refine prompt — when present, the system prompt includes the
  // previous output plus this instruction (spec §2: "Refine context").
  refineInstruction?: string;

  // The previous output for refine flows. Plain markdown text.
  previousOutput?: string;

  // For inline-rewrite mode: the selection range as plain text the model
  // should rewrite. The other modes leave this null.
  selectionText?: string;

  // Model selection — falls through to skill.config.modelPreference, then
  // the user's `modelDefaults.formatting`. Resolved by the runner.
  modelInstanceId: string;
  modelId: string;

  // Cancellation signal — wired to the in-flight registry / stop button.
  signal: AbortSignal;
}

// Final result returned to the tRPC caller. Plan 4 stages this as a diff
// candidate; Plan 5 dispatches INSERT_*_COMMAND on accept.
export interface SkillRunResult {
  artifactId: string;
  mode: ArtifactMode;
  skillId: string;     // slug; matches the artifacts.skill_id column
  skillName: string;
  version: number;     // pulled from the newly-inserted audit row
  generatedAt: string; // ISO 8601
  modelId: string;
  // The Lexical children that will become the node body when accepted.
  content: SerializedLexicalNode[];
  // The raw markdown the agent emitted — useful for refine flows
  // (passed back into a re-run as previousOutput).
  rawMarkdown: string;
  // Pre-run snapshot used by the diff overlay as the "before" side of the
  // char-level diff. Populated by the runner for `replace-doc` (the full
  // note body) and left undefined for `append-section` (the candidate is
  // purely additive — nothing to diff against). For `inline-rewrite` the
  // client supplies `beforeText` from the selection, so the runner does
  // not set it.
  beforeText?: string;
}
