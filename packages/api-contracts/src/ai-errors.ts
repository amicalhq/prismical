import { z } from 'zod';

/**
 * Stable, client-facing error codes for AI work (skill runs, Ask AI, transcription). Shared here
 * so every consumer — core, the desktop local lane, app-client — matches on ONE vocabulary
 * instead of each keeping its own copy. The codes describe the CAUSE, never the transport: a
 * client picks copy and a recovery action from the code plus {@link AiErrorDetails}, and never
 * from `message` (server prose) or a status code.
 */
export const AI_ERROR_CODES = {
  // ── Provider / key lane (classified from the provider's own response) ───────────────────────
  /** 401/403 from the provider: the key is wrong, revoked, or lacks access. User-fixable. */
  PROVIDER_KEY_INVALID: 'PROVIDER_KEY_INVALID',
  /** The chosen BYOK instance has no credential on file (deleted / never saved). User-fixable. */
  PROVIDER_KEY_MISSING: 'PROVIDER_KEY_MISSING',
  /** Billing / credit exhausted at the provider (402, or a 429 that names quota). User-fixable. */
  PROVIDER_QUOTA_EXCEEDED: 'PROVIDER_QUOTA_EXCEEDED',
  /** Rate limited (429). Retry after `details.retryAfterMs`. */
  PROVIDER_RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  /** The model id is unknown / retired at the provider (404). User-fixable. */
  PROVIDER_MODEL_NOT_FOUND: 'PROVIDER_MODEL_NOT_FOUND',
  /** The provider refused the input as too long for the model's context. */
  PROVIDER_CONTEXT_TOO_LONG: 'PROVIDER_CONTEXT_TOO_LONG',
  /** The model / provider does not support tool calling, which Skills and Ask require. */
  PROVIDER_TOOLS_UNSUPPORTED: 'PROVIDER_TOOLS_UNSUPPORTED',
  /** Any other 4xx the provider returned for the request itself. */
  PROVIDER_REJECTED: 'PROVIDER_REJECTED',
  /** 5xx, timeout, or a network fault reaching the provider. Retryable, not user-fixable. */
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',

  // ── Model resolution (before any provider call) ─────────────────────────────────────────────
  /** The managed lane has no provider configured for this capability (503). */
  MODEL_NOT_CONFIGURED: 'MODEL_NOT_CONFIGURED',
  /** The selection cannot be used here: no model id, unsupported provider, not in the curated list. */
  MODEL_SELECTION_INVALID: 'MODEL_SELECTION_INVALID',
  /** The chosen BYOK instance no longer exists. */
  INSTANCE_NOT_FOUND: 'INSTANCE_NOT_FOUND',
  /** BYOK is refused on this lane (admin override). */
  BYOK_NOT_ALLOWED: 'BYOK_NOT_ALLOWED',

  // ── Ask AI outcomes that are not errors but need telling (delivered as message metadata) ────
  /** The tool loop spent its step budget without producing an answer. */
  ASK_STEPS_EXHAUSTED: 'ASK_STEPS_EXHAUSTED',
  /** The answer hit the output-token cap and stopped mid-way. */
  ASK_OUTPUT_TRUNCATED: 'ASK_OUTPUT_TRUNCATED',
  /** The request never reached the model (transport / pre-stream failure with no finer cause). */
  ASK_REQUEST_FAILED: 'ASK_REQUEST_FAILED',
  /** The chosen BYOK instance was gone, so the run went to Prismical Cloud instead. */
  MODEL_FALLBACK_TO_CLOUD: 'MODEL_FALLBACK_TO_CLOUD',

  // ── Transcription (the wire code predates this vocabulary and is kept for older clients) ───
  /** The member has used this month's included Cloud transcription (402, enforce mode only). */
  TRANSCRIPTION_QUOTA_EXCEEDED: 'TRANSCRIPTION_QUOTA_EXCEEDED',
  /**
   * The chunk starts past the longest single recording this plan allows, or past the global
   * technical ceiling (413). Distinct from the quota above: that one is "no allowance left this
   * month", this one is "this ONE session has run long enough". Starting a new recording works.
   */
  RECORDING_LENGTH_EXCEEDED: 'RECORDING_LENGTH_EXCEEDED',

  // ── Plan entitlements (decided before any provider call; see core `usage/entitlements.ts`) ──
  /** Ask AI is not included in the organization's plan. */
  ASK_NOT_IN_PLAN: 'ASK_NOT_IN_PLAN',
  /** This period's AI credits (successful managed skill runs) are used up. */
  AI_CREDITS_EXHAUSTED: 'AI_CREDITS_EXHAUSTED',
  /**
   * A BYOK instance was chosen but the plan does not include BYOK. On a run this is a NOTICE (the
   * run went to Prismical Cloud instead); on instance creation it is the 402 code.
   */
  BYOK_NOT_IN_PLAN: 'BYOK_NOT_IN_PLAN',
} as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[keyof typeof AI_ERROR_CODES];

/** Skill-run outcomes (POST /me/skills/:id/run). Documented in detail in core's skills/types.ts. */
export const SKILL_RUN_ERROR_CODES = {
  NOTE_EMPTY: 'NOTE_EMPTY',
  NO_TRANSCRIPT: 'NO_TRANSCRIPT',
  SELECTION_REQUIRED: 'SELECTION_REQUIRED',
  TRANSCRIPT_FINALIZING: 'TRANSCRIPT_FINALIZING',
  OUTPUT_TOO_LONG: 'OUTPUT_TOO_LONG',
  OUTPUT_MALFORMED: 'OUTPUT_MALFORMED',
  /** `submit_output` ran but the markdown was empty, and the model gave no reason. */
  OUTPUT_EMPTY: 'OUTPUT_EMPTY',
  /**
   * The model withheld output that its own prompt lets it withhold. Distinct from
   * {@link OUTPUT_EMPTY} because it is a CORRECT answer, not a fault: described at severity `info`
   * with no retry action, since re-running reproduces the same answer and bills for it again.
   *
   * Emitted for ONE case today: the naming lane answering `title: null`, which its tool
   * description explicitly asks for when a note holds too little to name. That is the only place a
   * skill prompt currently sanctions returning nothing.
   *
   * A body skill returning empty markdown is NOT this, even when it writes an explanation into
   * `reasoning`. `reasoning` is a required field the model fills on every run and no prompt ties it
   * to declining, so reading intent from it would reclassify ordinary generation failures as
   * correct answers and strip their retry. Widening this code means giving the body prompt a real
   * decline channel first.
   */
  OUTPUT_DECLINED: 'OUTPUT_DECLINED',
  TOOL_BUDGET_EXHAUSTED: 'TOOL_BUDGET_EXHAUSTED',
  OUTPUT_NOT_SUBMITTED: 'OUTPUT_NOT_SUBMITTED',
  TITLE_INVALID: 'TITLE_INVALID',
  TITLE_TIMEOUT: 'TITLE_TIMEOUT',
  TITLE_CHANGED: 'TITLE_CHANGED',
  TITLE_SKILL_UNAVAILABLE: 'TITLE_SKILL_UNAVAILABLE',
} as const;
export type SkillRunErrorCode = (typeof SKILL_RUN_ERROR_CODES)[keyof typeof SKILL_RUN_ERROR_CODES];

/** Which credential the failing call ran on — drives "your key" vs "Prismical Cloud" copy. */
export const AiErrorLaneSchema = z.enum(['your-key', 'prismical-cloud']);
export type AiErrorLane = z.output<typeof AiErrorLaneSchema>;

/**
 * Recovery actions a client can offer. The SERVER decides which apply (in `details.user`); a
 * client implements each kind generically and ignores kinds it does not know, so a new action
 * ships without a client release everywhere except where it is needed.
 */
export const AI_ERROR_ACTION_KINDS = [
  'retry',
  'open-ai-models',
  'use-cloud',
  'choose-model',
  'append-instead',
  /** Ask: send a "continue" turn after a truncated answer. */
  'continue',
  /** Plan gates: open Settings → Billing (upgrade, or see what the plan includes). */
  'open-billing',
] as const;
export type AiErrorActionKind = (typeof AI_ERROR_ACTION_KINDS)[number];

export const AiErrorActionSchema = z
  .object({
    /** One of {@link AI_ERROR_ACTION_KINDS}; typed as string on the wire for forward compatibility. */
    kind: z.string().min(1),
    label: z.string().min(1),
  })
  .strip();
export type AiErrorAction = z.output<typeof AiErrorActionSchema>;

export const AiUserErrorSeveritySchema = z.enum(['info', 'warning', 'error']);
export type AiUserErrorSeverity = z.output<typeof AiUserErrorSeveritySchema>;

/**
 * What the user sees, rendered server-side in the caller's locale: title, optional body, how
 * loudly to show it, and the actions to offer in order. Clients render this as-is.
 */
export const AiUserErrorSchema = z
  .object({
    title: z.string().min(1),
    body: z.string().optional(),
    // A newer core may add a severity this client does not know: keep the notice, downgrade it.
    severity: AiUserErrorSeveritySchema.catch('warning'),
    actions: z.array(AiErrorActionSchema),
  })
  .strip();
export type AiUserError = z.output<typeof AiUserErrorSchema>;

/**
 * Structured context riding in the error envelope's `details` for AI failures. Everything a
 * client needs to phrase the message and offer the right action, and nothing it should render
 * verbatim (no provider prose, no response bodies).
 */
export const AiErrorDetailsSchema = z
  .object({
    lane: AiErrorLaneSchema.optional(),
    /** Provider id as configured (`openai`, `anthropic`, `deepgram`, …). */
    provider: z.string().optional(),
    /** Model id the call ran on, when known. */
    model: z.string().optional(),
    /** Whether the same request may succeed if simply retried. */
    retryable: z.boolean().optional(),
    /** For rate limits: how long to wait before retrying, when the provider said. */
    retryAfterMs: z.number().int().nonnegative().optional(),
    /** The localized, user-facing description (see `describeAiError`). */
    user: AiUserErrorSchema.optional(),
  })
  .strip();
export type AiErrorDetails = z.output<typeof AiErrorDetailsSchema>;

/** Parse `details` off any error envelope; unknown shapes yield `{}` rather than throwing. */
export function parseAiErrorDetails(details: unknown): AiErrorDetails {
  const parsed = AiErrorDetailsSchema.safeParse(details);
  return parsed.success ? parsed.data : {};
}

/**
 * Ask AI streams over the AI SDK's UI-message protocol, whose `error` part carries ONE string.
 * Core packs the structured error into that string so the client gets the same code + `user`
 * block it gets on JSON endpoints; anything that is not this envelope is treated as prose (the
 * desktop local lane writes actionable sentences directly).
 */
export const AskStreamErrorPayloadSchema = z
  .object({
    prismicalError: z.object({ code: z.string().min(1), details: AiErrorDetailsSchema.optional() }),
  })
  .strip();
export type AskStreamErrorPayload = z.output<typeof AskStreamErrorPayloadSchema>;

/**
 * Request header an Ask client sends to say it parses the JSON error envelope (below). Without it
 * core writes the error part as plain localized prose only - a client that prints `error.message`
 * verbatim (the mobile app today) then shows a sentence, never a JSON line.
 */
export const ASK_ERROR_FORMAT_HEADER = 'x-prismical-ask-error-format';
export const ASK_ERROR_FORMAT_ENVELOPE = 'envelope';

/** The plain-prose form of an Ask error part: title, then body. */
export function askStreamErrorProse(details?: AiErrorDetails): string | null {
  const user = details?.user;
  if (!user) return null;
  return `${user.title}${user.body ? ` ${user.body}` : ''}`;
}

/**
 * The error part's single string: the user-facing prose FIRST (title, then body), then the JSON
 * envelope on its own line. A client that predates the envelope shows `error.message` as-is and
 * so still reads real, localized copy; a current client parses the envelope and renders the
 * actions. When there is no `user` block the string is the envelope alone.
 */
export function encodeAskStreamError(code: string, details?: AiErrorDetails): string {
  const json = JSON.stringify({
    prismicalError: { code, details },
  } satisfies AskStreamErrorPayload);
  const prose = askStreamErrorProse(details);
  return prose === null ? json : `${prose}\n${json}`;
}

export function parseAskStreamError(text: string | undefined | null): AskStreamErrorPayload | null {
  if (!text) return null;
  const start = text.indexOf('{"prismicalError"');
  if (start < 0) return null;
  try {
    const parsed = AskStreamErrorPayloadSchema.safeParse(JSON.parse(text.slice(start)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Per-message metadata Ask attaches on the finish (and start) events: how the model stopped and,
 * when there is something the user should know that is not an error — the answer was cut short,
 * the tool loop ran dry, the run fell back to Prismical Cloud — a server-rendered `notice` with
 * its actions. Clients render `notice` under the answer; the rest is diagnostic.
 */
export const AskMessageMetadataSchema = z
  .object({
    finishReason: z.string().optional(),
    // `null` clears an earlier notice on the same message (the client merges metadata).
    notice: AiUserErrorSchema.extend({ code: z.string().min(1) }).nullish(),
  })
  .strip();
export type AskMessageMetadata = z.output<typeof AskMessageMetadataSchema>;

export function parseAskMessageMetadata(metadata: unknown): AskMessageMetadata | null {
  const parsed = AskMessageMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}
