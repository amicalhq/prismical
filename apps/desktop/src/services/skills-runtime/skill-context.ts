import type { ArtifactMode, Skill } from "@/db/schema";
import type { JSONContent } from "@tiptap/core";

// The runtime is stateless per call. All inputs the runner needs are bound
// into this context object once. The runner deterministically gathers
// note/transcript/selection from these — the model never picks what to read.
export interface SkillRunContext {
  // The skill being run. Loaded once via SkillsService.getBySlug.
  skill: Skill;

  // The note this run targets. Used by collectInput + the audit write path.
  noteId: number;

  // Active mode for this run — equals skill.config.editingOptions unless the
  // user overrode via the picker's `⋯` menu.
  mode: ArtifactMode;

  // Optional refine prompt — when present, the system prompt includes the
  // previous output plus this instruction.
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

  // Provider-specific tuning knobs. All optional; passed through to the
  // matching `providerOptions.<vendor>` block on generateText. The runner
  // only forwards keys the resolved provider understands — pinning these
  // here doesn't constrain other providers.

  // OpenAI reasoning effort (gpt-5, o-series). `'none'` is gpt-5.1-only;
  // `'xhigh'` is gpt-5.1-Codex-Max-only. Provider validates per-model.
  openaiReasoningEffort?:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh";

  // Anthropic reasoning effort (claude-opus-4-5+). Provider validates per-model.
  anthropicEffort?: "low" | "medium" | "high" | "xhigh" | "max";

  // Anthropic thinking mode. `'adaptive'` is sonnet-4-6+; explicit
  // `'enabled'` + budgetTokens is the older shape.
  anthropicThinking?:
    | { type: "adaptive"; display?: boolean }
    | { type: "enabled"; budgetTokens: number; display?: boolean };

  // Anthropic structured-output mode. `'auto'` picks `outputFormat` for
  // sonnet-4.5+ and `jsonTool` for older models. Leave at default unless
  // a specific skill fails.
  anthropicStructuredOutputMode?: "outputFormat" | "jsonTool" | "auto";

  // Groq reasoning format. `'parsed'` strips reasoning from final text
  // (typical for skills); `'raw'` keeps it inline; `'hidden'` omits it.
  groqReasoningFormat?: "parsed" | "raw" | "hidden";

  // Groq reasoning effort. Model-specific values; see Groq docs.
  groqReasoningEffort?: "low" | "medium" | "high" | "none" | "default";

  // Groq service tier. `'flex'` is a 10× rate-limit tier for non-critical
  // work. Defaults to `'on_demand'`.
  groqServiceTier?: "on_demand" | "performance" | "flex" | "auto";
}

// Final result returned to the tRPC caller. Every **accepted** run writes a
// new artifacts row, so the runner emits an unpersisted candidate and the
// audit row is written separately by `skillRuns.accept` after the user
// clicks Accept. Reject is a no-op DB-wise.
//
// Audit-meta fields (`modelInstanceId`, `providerType`, `refineInstruction`,
// `selectionText`, `reasoning`) are propagated through here so the accept
// mutation has everything it needs without a second model call or another
// db lookup.
export interface SkillRunResult {
  mode: ArtifactMode;
  skillId: string;     // slug; matches artifacts.skill_id when written
  skillName: string;
  modelId: string;
  modelInstanceId: string;
  providerType: string;
  // The TipTap children that will become the node body when accepted.
  content: JSONContent[];
  // The raw markdown the model emitted — kept around for the refine flow
  // (passed back as previousOutput) and stored on the audit row at accept.
  rawMarkdown: string;
  // Pre-run snapshot used by the diff overlay as the "before" side of the
  // char-level diff. Populated by the runner for `replace-doc` (the full
  // note body) and left undefined for `append-section` (purely additive).
  // For `inline-rewrite` the client supplies `beforeText` from the
  // selection, so the runner does not set it.
  beforeText?: string;
  // Audit-meta fields, propagated to the accept mutation.
  refineInstruction: string | null;
  selectionText: string | null;
  reasoning: string | null;
  // LLM token-usage snapshot (t-07). Optional — some providers don't
  // surface it. Forwarded to the artifacts audit row by `skillRuns.accept`.
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    raw?: string; // JSON.stringify of the full LanguageModelUsage payload
  };
}
