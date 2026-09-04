/**
 * The pure half of a skill run's contract — the pieces `buildSkillSystemPrompt` and the terminal
 * tool need, with no database or handler coupling. Runtime-specific schemas,
 * error codes and managed routing stay with the caller.
 */

import { z } from 'zod';
import { type ArtifactMode as ContractArtifactMode } from '@prismical/api-contracts/apps/v1';

/** How a skill writes its result back into the note. inline-rewrite is accepted but deferred. */
export type ArtifactMode = ContractArtifactMode;

/**
 * Structured output contract shared by the model call. `reasoning` is `.nullable()` (NOT
 * `.optional()`): strict structured outputs require every property to be `required`, so a
 * nullable-but-present key is the way to let the model omit reasoning. Mirrors the desktop
 * output schema so the two implementations don't drift. Non-empty markdown is validated post-parse
 * (the schema cannot express it with `minLength` in strict mode).
 */
export const skillOutputSchema = z.object({
  // The .describe() rides into the structured-output JSON schema the model sees — cheap
  // reinforcement of the no-fence rule at the layer closest to generation.
  markdown: z
    .string()
    .describe('Markdown for the note body. Never wrap the whole value in a code fence.'),
  reasoning: z.string().nullable(),
});
export type SkillOutput = z.infer<typeof skillOutputSchema>;

/**
 * The terminal tool a skill run must call to deliver its result.
 *
 * Shared by runtime and tests so every caller emits exactly the same tool name.
 */
export const SUBMIT_OUTPUT_TOOL = 'submit_output';

/**
 * The tool's description is part of the prompt, so all callers share one definition.
 */
export const SUBMIT_OUTPUT_TOOL_DESCRIPTION =
  'Submit the finished result of the skill. Call this EXACTLY ONCE, as the last thing you do, ' +
  'with the complete output — never partial work, and never a preamble in the chat.';

/**
 * The user turn of a skill run. The instructions carry everything else, so this string is a
 * constant rather than a template — and, like the tool description above, it is prompt: it belongs
 * next to the contract, not inline in one caller.
 */
export const SKILL_RUN_USER_PROMPT = 'Run the skill as instructed in the system prompt.';

/**
 * Fixed ids of the two global system skills (owner-null rows, `system: true`).
 * These aren't just any skill: `skl_enhance` is THE recording→note action (the only skill in the
 * "Enhance lane" — the one that folds a recording into the note and drives the provenance/mode bias),
 * and `skl_cleanup` is the whole-note copy-editor. Routing keys off these ids.
 */
export const ENHANCE_SKILL_ID = 'skl_enhance';
export const CLEANUP_SKILL_ID = 'skl_cleanup';
