/**
 * Shared pure Ask tool specs and run limits, with no database or handler
 * coupling. Tool descriptions and input schemas are prompt input, so cloud and
 * local callers use one definition rather than drifting apart.
 */

import { z } from 'zod';

export const ASK_SEARCH_NOTES_TOOL = 'search_notes';
export const ASK_GET_NOTE_TOOL = 'get_note';

/**
 * The two built-ins in stable registration order. Progressive disclosure keeps
 * both visible on the MCP path.
 */
export const ASK_BUILTIN_TOOL_NAMES = [ASK_SEARCH_NOTES_TOOL, ASK_GET_NOTE_TOOL] as const;

/**
 * Default `k` when the model passes `null`. The schema description is built
 * from the same constant so prompt text and runtime behavior stay aligned.
 */
export const ASK_SEARCH_DEFAULT_K = 8;

/**
 * Optional tool inputs use `.nullable()` rather than `.optional()` because
 * strict structured tools require every key in `required`. The `.describe()`
 * strings become part of the JSON schema the model sees.
 */
export const askSearchNotesInputSchema = z.object({
  query: z
    .string()
    .describe(
      'Search terms: keywords, names, or a short phrase. Pass an empty string to browse recent notes.'
    ),
  k: z
    .number()
    .int()
    .min(1)
    .max(20)
    .nullable()
    .describe(`Max results (default ${ASK_SEARCH_DEFAULT_K}). Pass null to use the default.`),
});
export type AskSearchNotesInput = z.infer<typeof askSearchNotesInputSchema>;

export const askGetNoteInputSchema = z.object({
  noteId: z.string().describe('The noteId to fetch (from a search_notes result).'),
});
export type AskGetNoteInput = z.infer<typeof askGetNoteInputSchema>;

/** One built-in tool's prompt surface: everything except the executor. */
export interface AskToolSpec<TSchema extends z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TSchema;
}

export const ASK_SEARCH_NOTES_SPEC = {
  name: ASK_SEARCH_NOTES_TOOL,
  description:
    "Search or browse the notes the user can read. Returns ranked matches with a short snippet. Use focused keywords to find relevant notes, or an empty query to list the user's most recently updated notes.",
  inputSchema: askSearchNotesInputSchema,
} as const satisfies AskToolSpec<typeof askSearchNotesInputSchema>;

export const ASK_GET_NOTE_SPEC = {
  name: ASK_GET_NOTE_TOOL,
  description:
    'Fetch the full plain text of one note by its noteId. Use after search when a snippet is not enough.',
  inputSchema: askGetNoteInputSchema,
} as const satisfies AskToolSpec<typeof askGetNoteInputSchema>;

/** Both specs in stable registration order. */
export const ASK_TOOL_SPECS = [ASK_SEARCH_NOTES_SPEC, ASK_GET_NOTE_SPEC] as const;

/** Characters of body text one `search_notes` hit carries. Part of what the model sees. */
export const ASK_SNIPPET_CHARS = 600;

/**
 * Result shapes shared by Ask callers. `snippet` is
 * `contentText.slice(0, ASK_SNIPPET_CHARS)`; `rank` is the retrieval score
 * (browse mode uses 0).
 */
export interface AskSearchResult {
  noteId: string;
  title: string;
  snippet: string;
  rank: number;
}

export interface AskGetNoteFound {
  noteId: string;
  title: string;
  content: string;
}

/**
 * What `get_note` returns for an id the caller may not read. Deliberately does NOT distinguish
 * "absent" from "forbidden": telling the model which one it was is an existence oracle.
 */
export const ASK_GET_NOTE_NOT_FOUND = { error: 'not_found_or_forbidden' } as const;

export type AskGetNoteResult = AskGetNoteFound | typeof ASK_GET_NOTE_NOT_FOUND;

/**
 * Step budgets for the tool loop. Integration use can require discovery steps
 * before a tool call, so the notes-only and MCP limits remain separate even
 * while their current values match.
 */
export const ASK_STEP_BUDGET_NOTES_ONLY = 8;
export const ASK_STEP_BUDGET_WITH_MCP = 8;

export function askStepBudget(hasMcpServers: boolean): number {
  return hasMcpServers ? ASK_STEP_BUDGET_WITH_MCP : ASK_STEP_BUDGET_NOTES_ONLY;
}

/**
 * Backstop, not a target: bounds pathological enumerate-everything runs while
 * leaving room for a normal answer and trailing `Sources:` line. Managed
 * callers can supply a tuned cap; BYOK uses this fallback.
 */
export const ASK_MAX_OUTPUT_TOKENS_FALLBACK = 8192;
