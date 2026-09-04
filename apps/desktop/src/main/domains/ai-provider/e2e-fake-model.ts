/**
 * The scripted language model behind PRISMICAL_E2E_FAKE_AI:
 * no network, deterministic output the packaged e2e asserts verbatim. It CALLS
 * the terminal tool for skill runs (a title when the schema has one) and
 * streams a fixed answer for Ask — the shapes core's fake seams use. Loaded
 * lazily from `ai/test` so a production package never evaluates the mock.
 */
import type { LanguageModel } from 'ai';
import { SUBMIT_OUTPUT_TOOL } from '@prismical/ai-prompts';

export const E2E_FAKE_MODEL_ID = 'e2e-fake';
export const E2E_FAKE_MARKDOWN =
  '## Summary\n\nThis is a deterministic local test summary.\n\n- First key point\n- Second key point';
export const E2E_FAKE_TITLE = 'Product launch planning';
export const E2E_FAKE_ANSWER = 'This is a deterministic local answer.';

const USAGE = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 24, text: 24, reasoning: 0 },
  totalTokens: 36,
};

export async function createE2EFakeModel(): Promise<LanguageModel> {
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  return new MockLanguageModelV4({
    modelId: E2E_FAKE_MODEL_ID,
    doGenerate: async options =>
      ({
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_e2e_fake',
            toolName: SUBMIT_OUTPUT_TOOL,
            input: JSON.stringify(
              options.tools?.some(
                t =>
                  t.type === 'function' &&
                  t.name === SUBMIT_OUTPUT_TOOL &&
                  Object.hasOwn((t.inputSchema as { properties?: object }).properties ?? {}, 'title')
              )
                ? { title: E2E_FAKE_TITLE }
                : { markdown: E2E_FAKE_MARKDOWN, reasoning: null }
            ),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: USAGE,
        warnings: [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only mock; avoids re-declaring the V4 content/usage unions
      }) as any,
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: '0' },
          { type: 'text-delta', id: '0', delta: E2E_FAKE_ANSWER },
          { type: 'text-end', id: '0' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only mock; avoids re-declaring the V4 stream-part union
      }) as ReadableStream<any>,
    }),
  });
}
