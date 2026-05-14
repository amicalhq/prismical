import type { LanguageModelV3 } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";

// Artificial latency so dev runs against the Mock provider exercise the UI's
// pending/loading states (Stop button, refine spinner, diff staging delay)
// instead of completing instantly. Mirrors `mock-note-generation-provider.ts`:
// `mock-language-slow` is for visually inspecting transitions; everything
// else stays snappy so dev iteration isn't painful.
const MOCK_LATENCY_MS_FAST = 500;
const MOCK_LATENCY_MS_SLOW = 3000;

// Canned structured output for dev/test runs against the Mock provider.
// Returns valid JSON that matches the runner's output schema. The shape is
// mode-aware — inline-rewrite gets a single short replacement (block-shaped
// output would be rejected by markdownToInlineChildren), block modes get
// the full multi-paragraph canned response.
const blockCanned = {
  markdown:
    "## Mock skill output\n\n" +
    "This was produced by the **Mock** language model. It does not reflect " +
    "your note's content — switch to a real provider in Settings → AI " +
    "Models to see the actual skill result.\n\n" +
    "- Pipeline wiring verified end-to-end\n" +
    "- Skill prompt was rendered with injected context\n" +
    "- Output schema accepted the result\n",
};

const inlineCanned = {
  markdown: "[mock rewrite — switch to a real provider for actual output]",
};

// Abortable sleep — generateText forwards its abortSignal to doGenerate via
// `options.abortSignal`. Without listening to it, the dock-bar's Stop button
// fires `InFlightRegistry.cancel` and aborts the signal, but the unrelated
// setTimeout in the mock still runs to completion before the run "finishes".
function abortableSleep(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createMockSkillModel(modelId: string): LanguageModelV3 {
  const latencyMs =
    modelId === "mock-language-slow"
      ? MOCK_LATENCY_MS_SLOW
      : MOCK_LATENCY_MS_FAST;
  return new MockLanguageModelV3({
    modelId,
    doGenerate: async (options) => {
      // The system prompt embeds the active mode; peek at it to pick the
      // right canned shape. LanguageModelV3 system messages carry a plain
      // string in `content`, so we don't need the part-array dance.
      const systemText = options.prompt
        .filter((m) => m.role === "system")
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n");
      const isInline = /Active mode: inline-rewrite/.test(systemText);
      const canned = isInline ? inlineCanned : blockCanned;
      await abortableSleep(latencyMs, options.abortSignal);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(canned) }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: {
            total: undefined,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: undefined,
            text: undefined,
            reasoning: undefined,
          },
          totalTokens: undefined,
        },
        warnings: [],
      };
    },
  });
}
