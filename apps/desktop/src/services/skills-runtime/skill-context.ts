import type { ArtifactMode, Skill } from "@/db/schema";
import type { SerializedLexicalNode } from "lexical";

// The runtime is stateless per call. All inputs the agent loop needs
// are bound into this context object once and passed through closures.
export interface SkillRunContext {
  // The skill being run. Loaded once via SkillsService.getBySlug.
  skill: Skill;

  // The note this run targets. Used by read_note / read_transcript / the
  // audit write path.
  noteId: number;

  // Active mode for this run — equals skill.config.editingOptions unless the
  // user overrode via the picker's `⋯` menu (Plan 5).
  mode: ArtifactMode;

  // Optional refine prompt — when present, the agent receives its previous
  // output plus this instruction (spec §2: "Refine context").
  refineInstruction?: string;

  // The previous output for refine flows. Plain markdown text.
  previousOutput?: string;

  // For inline-rewrite mode: the selection range as plain text the agent
  // should rewrite. The block-and-inline modes leave this null.
  selectionText?: string;

  // Model selection — falls through to skill.config.modelPreference, then
  // the user's `modelDefaults.formatting`. Resolved by the runner.
  modelInstanceId: string;
  modelId: string;

  // Cancellation signal — wired to the in-flight registry / stop button.
  signal: AbortSignal;
}

// The "final answer" the agent emits, captured by the write_section or
// replace_selection tool. The runner stores this as soon as either tool
// fires and uses it to terminate the loop.
export interface WriteSectionPayload {
  // Markdown content the agent wrote. Will be piped through
  // markdownToLexicalStateJson by the runner.
  markdown: string;
  // For replace-doc / append-section: not present; mode comes from context.
  // For inline-rewrite: same — context.mode determines wrapping.
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
