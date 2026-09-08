/**
 * The model call behind a local skill run implements the server's terminal-
 * tool contract (`submit_output`, `toolChoice: 'required'`, stop on the call)
 * with a FALLBACK LADDER the cloud lane never needed. A BYO key may point at
 * a model that rejects a forced tool choice (Anthropic's Fable-class models
 * 400 on `tool_choice: any`) or at a local runtime whose model cannot call
 * tools at all — and the plan's exit criterion is that Enhance, Cleanup and
 * Name-note work against a local runtime too. So:
 *
 *   native     → tools + toolChoice 'required' (the production contract);
 *   auto-only  → tools + toolChoice 'auto' + an explicit "call the tool" line;
 *   none       → no tools: the model answers with ONE JSON object, parsed
 *                leniently (fences stripped, outermost braces), and as the
 *                last resort the raw text IS the markdown.
 *
 * What a (provider, model) pair settles on is remembered by AiProvider so the
 * next run starts on the rung that worked. A rung is skipped only on evidence:
 * a provider 4xx on the call, or a completed turn that never called the tool.
 * Truncation and malformed tool input are NOT tool-support problems and fail
 * the run with core's codes.
 */
import type { LogMetadata } from '../../infra/logging/service';
import { APICallError, generateText, hasToolCall, stepCountIs, tool, type LanguageModelUsage } from 'ai';
import type { z } from 'zod';
import type { ResolvedAiModel, ToolSupport } from '../ai-provider/service';

export interface TerminalToolSpec<T> {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<T>;
  /** The JSON shape line shown on the `none` rung, e.g. `{"markdown": string, "reasoning": string|null}`. */
  readonly jsonShape: string;
  /**
   * Structural rescue of a JSON object that failed the schema (a small model
   * omitting `reasoning`, a `null` where a string was due): the payload's
   * fields, never its source text. Null = the object is unusable.
   */
  readonly salvage: (object: unknown) => T | null;
  /** Last-resort parse when the `none` rung returns NO JSON object at all: the text itself, or null. */
  readonly fromText: (text: string) => T | null;
}

export interface RunUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly raw: string;
}

export type RunFailureCode =
  | 'OUTPUT_TOO_LONG'
  | 'OUTPUT_MALFORMED'
  | 'OUTPUT_NOT_SUBMITTED'
  | 'PROVIDER_CALL_FAILED';

export type TerminalRunOutcome<T> =
  | { readonly kind: 'submitted'; readonly output: T; readonly usage: RunUsage; readonly support: ToolSupport }
  | {
      readonly kind: 'failed';
      readonly code: RunFailureCode;
      readonly errorType: string;
      readonly usage: RunUsage | null;
    };

export interface TerminalRunArgs<T> {
  readonly resolved: ResolvedAiModel;
  readonly system: string;
  readonly prompt: string;
  readonly tool: TerminalToolSpec<T>;
  readonly abortSignal: AbortSignal;
  readonly maxOutputTokens?: number;
  /** Persist what the ladder learned (AiProvider.rememberToolSupport). */
  readonly remember: (support: ToolSupport) => Promise<void>;
  readonly log: (message: string, data?: LogMetadata['context']) => void;
}

const toUsage = (usage: LanguageModelUsage | undefined): RunUsage => ({
  ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
  ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
  ...(usage?.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
  raw: JSON.stringify(usage ?? {}),
});

const RUNGS: Record<ToolSupport, ReadonlyArray<Exclude<ToolSupport, 'unknown'>>> = {
  unknown: ['native', 'auto-only', 'none'],
  native: ['native', 'auto-only', 'none'],
  'auto-only': ['auto-only', 'none'],
  none: ['none'],
};

/**
 * A provider rejecting the TOOL SHAPE on a tool rung is the evidence to step
 * down: `tool_choice` unsupported (Anthropic's Fable-class models), tools
 * unsupported (Ollama: "<model> does not support tools", llama.cpp), a tool
 * schema the server cannot take. It must be a 400/422 whose body or message
 * actually names tools — a context-length 400, a bad-key 400, a 404 model,
 * a 413 payload are NOT about tools, and stepping down on them would silently
 * trade the structured contract for prose on the very runs that most need it.
 */
const TOOL_WORDS = /\b(tools?|tool_choice|tool[ _-]?calls?|function[ _-]?call(ing|s)?|functions?)\b/i;
export const isToolShapeRejection = (error: unknown): boolean => {
  if (!APICallError.isInstance(error)) return false;
  if (error.statusCode !== 400 && error.statusCode !== 422) return false;
  const body = typeof error.responseBody === 'string' ? error.responseBody : '';
  return TOOL_WORDS.test(body) || TOOL_WORDS.test(error.message);
};

/**
 * The FIRST complete `{…}` in the text, found by a brace scan that respects
 * JSON string literals and escapes — so a fenced code block INSIDE a markdown
 * string value (`"markdown": "…\`\`\`ts…"`) is preserved verbatim, and prose
 * after the object does not push the closing brace to a later `}`. A reply
 * that is one whole fenced block is unwrapped first (the common small-model
 * shape); fences elsewhere are left alone.
 */
export const extractJsonObject = (text: string): unknown | undefined => {
  const trimmed = text.trim();
  const whole = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  const source = whole ? whole[1]!.trim() : trimmed;
  const start = source.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1)) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
};

type ToolAttempt<T> =
  | { readonly kind: 'submitted'; readonly output: T; readonly usage: RunUsage }
  | { readonly kind: 'no-call'; readonly usage: RunUsage }
  | { readonly kind: 'failed'; readonly code: RunFailureCode; readonly errorType: string; readonly usage: RunUsage };

const AUTO_NUDGE = (name: string): string =>
  `\n\nYou MUST deliver your result by calling the \`${name}\` tool. Do not answer in the chat.`;

const JSON_DIRECTIVE = (shape: string): string =>
  '\n\n# Output format\n' +
  'This environment cannot receive tool calls. Instead, reply with ONLY a single JSON object and ' +
  `nothing else — no prose before or after it, no code fence — of the form: ${shape}`;

export async function runTerminalTool<T>(args: TerminalRunArgs<T>): Promise<TerminalRunOutcome<T>> {
  const { resolved } = args;
  const rungs = RUNGS[resolved.toolSupport];
  let lastUsage: RunUsage | null = null;
  // The memo is written ONLY on evidence that survives a second look: a
  // provider that rejected the tool shape (an explicit 4xx naming tools), or
  // a native success from 'unknown'. A single turn where the model merely
  // chose prose steps down for THIS run but is not remembered — one chatty
  // turn must not demote a tool-capable model for the rest of the session.
  let rejectedAbove = false;

  for (let index = 0; index < rungs.length; index += 1) {
    const rung = rungs[index]!;
    const hasNext = index < rungs.length - 1;
    try {
      const attempt =
        rung === 'none' ? await attemptJson(args) : await attemptTool(args, rung === 'native');
      lastUsage = attempt.usage;
      if (attempt.kind === 'submitted') {
        const learned = rung === 'native' ? resolved.toolSupport === 'unknown' : rejectedAbove;
        if (learned && rung !== resolved.toolSupport) await args.remember(rung);
        return { kind: 'submitted', output: attempt.output, usage: attempt.usage, support: rung };
      }
      if (attempt.kind === 'failed') return attempt;
      // The model completed a turn without calling the tool: on a tool rung
      // that is the evidence to step down; on the last rung it is the failure.
      args.log('skill run: model ignored the terminal tool', {
        provider: resolved.provider,
        model: resolved.modelId,
        rung,
        stepDown: hasNext,
      });
      if (!hasNext) {
        return {
          kind: 'failed',
          code: 'OUTPUT_NOT_SUBMITTED',
          errorType: 'output_not_submitted',
          usage: attempt.usage,
        };
      }
    } catch (error) {
      if (args.abortSignal.aborted) throw error;
      if (rung !== 'none' && hasNext && isToolShapeRejection(error)) {
        rejectedAbove = true;
        args.log('skill run: provider rejected the tool request — stepping down', {
          provider: resolved.provider,
          model: resolved.modelId,
          rung,
          status: (error as APICallError).statusCode,
        });
        continue;
      }
      if (APICallError.isInstance(error)) {
        args.log('skill run: provider call failed', {
          provider: resolved.provider,
          model: resolved.modelId,
          rung,
          status: error.statusCode,
        });
        return {
          kind: 'failed',
          code: 'PROVIDER_CALL_FAILED',
          errorType: 'provider_call_failed',
          usage: lastUsage,
        };
      }
      throw error;
    }
  }
  return {
    kind: 'failed',
    code: 'OUTPUT_NOT_SUBMITTED',
    errorType: 'output_not_submitted',
    usage: lastUsage,
  };
}

async function attemptTool<T>(args: TerminalRunArgs<T>, forced: boolean): Promise<ToolAttempt<T>> {
  const { resolved, tool: spec } = args;
  let submitted: T | undefined;
  const terminal = tool({
    description: spec.description,
    inputSchema: spec.schema,
    execute: (input: T) => {
      submitted = input;
      return { received: true };
    },
  });
  const result = await generateText({
    model: resolved.model,
    instructions: forced ? args.system : args.system + AUTO_NUDGE(spec.name),
    prompt: args.prompt,
    tools: { [spec.name]: terminal },
    toolChoice: forced ? 'required' : 'auto',
    stopWhen: [hasToolCall(spec.name), stepCountIs(2)],
    ...(args.maxOutputTokens === undefined ? {} : { maxOutputTokens: args.maxOutputTokens }),
    maxRetries: 1,
    abortSignal: args.abortSignal,
  });
  const usage = toUsage(result.usage);
  if (submitted !== undefined) return { kind: 'submitted', output: submitted, usage };

  // Match on `invalid` alone: in ai@7 a malformed tool input never throws;
  // it rides the call.
  const invalidCall = result.toolCalls.find(
    call => (call as { invalid?: boolean }).invalid === true
  );
  const outOfBudget = result.finishReason === 'length';
  if (invalidCall && outOfBudget) {
    return { kind: 'failed', code: 'OUTPUT_TOO_LONG', errorType: 'output_truncated_tool_input', usage };
  }
  if (invalidCall) {
    return {
      kind: 'failed',
      code: 'OUTPUT_MALFORMED',
      errorType: invalidCall.toolName === spec.name ? 'output_malformed' : 'wrong_tool_called',
      usage,
    };
  }
  if (outOfBudget) {
    return { kind: 'failed', code: 'OUTPUT_TOO_LONG', errorType: 'output_truncated', usage };
  }
  return { kind: 'no-call', usage };
}

async function attemptJson<T>(args: TerminalRunArgs<T>): Promise<ToolAttempt<T>> {
  const { resolved, tool: spec } = args;
  const result = await generateText({
    model: resolved.model,
    instructions: args.system + JSON_DIRECTIVE(spec.jsonShape),
    prompt: args.prompt,
    ...(args.maxOutputTokens === undefined ? {} : { maxOutputTokens: args.maxOutputTokens }),
    maxRetries: 1,
    abortSignal: args.abortSignal,
  });
  const usage = toUsage(result.usage);
  if (result.finishReason === 'length') {
    return { kind: 'failed', code: 'OUTPUT_TOO_LONG', errorType: 'output_truncated', usage };
  }
  const text = result.text ?? '';
  const object = extractJsonObject(text);
  if (object !== undefined) {
    // The reply IS JSON: use its fields, never its source text as the answer.
    const parsed = spec.schema.safeParse(object);
    if (parsed.success) return { kind: 'submitted', output: parsed.data, usage };
    const salvaged = spec.salvage(object);
    if (salvaged !== null) return { kind: 'submitted', output: salvaged, usage };
    return { kind: 'failed', code: 'OUTPUT_MALFORMED', errorType: 'output_malformed', usage };
  }
  const fallback = spec.fromText(text);
  if (fallback !== null) return { kind: 'submitted', output: fallback, usage };
  return { kind: 'no-call', usage };
}
