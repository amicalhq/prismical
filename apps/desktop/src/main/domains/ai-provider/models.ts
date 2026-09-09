/**
 * LanguageModel construction per provider. OpenAI and Anthropic
 * use their AI-SDK packages; OpenRouter, Ollama and other
 * OpenAI-compatible servers use `@ai-sdk/openai-compatible` (Ollama
 * serves the OpenAI chat protocol, tools included, under `/v1`). The key is
 * handed to the SDK and nowhere else — never logged, never in an error.
 */
import { desktopFetch } from '../../infra/http/client';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { AiProviderKind } from '@prismical/desktop-contracts';
import { normalizeBaseUrl, ollamaChatBaseUrl, type FetchLike } from './catalogue';

export interface BuildModelArgs {
  readonly provider: AiProviderKind;
  readonly modelId: string;
  readonly apiKey: string | null;
  /** Already resolved against PROVIDER_DEFAULTS by the caller (null = the SDK default). */
  readonly baseUrl: string | null;
  readonly fetchFn?: FetchLike;
}

export function buildLanguageModel(args: BuildModelArgs): LanguageModel {
  const fetch = (args.fetchFn as typeof globalThis.fetch | undefined) ?? desktopFetch;
  switch (args.provider) {
    case 'openai':
      return createOpenAI({
        apiKey: args.apiKey ?? undefined,
        ...(args.baseUrl ? { baseURL: normalizeBaseUrl(args.baseUrl) } : {}),
        fetch,
      })(args.modelId);
    case 'anthropic':
      return createAnthropic({
        apiKey: args.apiKey ?? undefined,
        ...(args.baseUrl ? { baseURL: normalizeBaseUrl(args.baseUrl) } : {}),
        fetch,
      })(args.modelId);
    case 'openrouter':
    case 'openai-compatible':
      return createOpenAICompatible({
        name: args.provider,
        baseURL: normalizeBaseUrl(args.baseUrl ?? ''),
        ...(args.apiKey ? { apiKey: args.apiKey } : {}),
        fetch,
      }).chatModel(args.modelId);
    case 'ollama':
      return createOpenAICompatible({
        name: 'ollama',
        baseURL: ollamaChatBaseUrl(args.baseUrl ?? ''),
        fetch,
      }).chatModel(args.modelId);
  }
}
