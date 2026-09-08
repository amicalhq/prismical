import { describe, expect, it } from "vitest";
import {
  CLOUD_CATALOG_PROVIDERS,
  HIDDEN_PROVIDER_TYPES,
  PROVIDER_FEATURE_KEYS,
  isProviderVisible,
  PROVIDER_TYPE_CAPABILITIES,
  PROVIDER_TYPE_COMING_SOON,
  PROVIDER_TYPES,
} from "./providers";

describe("AI provider availability", () => {
  it("leaves global suppression empty so organization flags control visibility", () => {
    expect(HIDDEN_PROVIDER_TYPES.size).toBe(0);
  });

  it("enables only cloud providers backed by the core catalog", () => {
    expect(CLOUD_CATALOG_PROVIDERS).toEqual([
      PROVIDER_TYPES.openai,
      PROVIDER_TYPES.openRouter,
      PROVIDER_TYPES.googleGemini,
      PROVIDER_TYPES.deepgram,
    ]);
    for (const provider of CLOUD_CATALOG_PROVIDERS) {
      expect(PROVIDER_TYPE_COMING_SOON[provider]).toBe(false);
    }
  });

  // Deepgram is the first catalog provider with no language models. The pickers and the
  // connect/edit wizard branch on this list, so a stray "language" here would offer
  // Deepgram instances for Ask and Skills, where every run would 422 unsupported_provider.
  it("keeps Deepgram transcription-only", () => {
    expect(PROVIDER_TYPE_CAPABILITIES[PROVIDER_TYPES.deepgram]).toEqual([
      "transcription",
    ]);
  });

  it("marks unsupported cloud providers as coming soon", () => {
    const unsupported = [
      PROVIDER_TYPES.anthropic,
      PROVIDER_TYPES.groq,
      PROVIDER_TYPES.ollama,
      PROVIDER_TYPES.openAICompatible,
      PROVIDER_TYPES.vercelAIGateway,
      PROVIDER_TYPES.cloudflareWorkersAI,
      PROVIDER_TYPES.cerebras,
    ];
    for (const provider of unsupported) {
      expect(PROVIDER_TYPE_COMING_SOON[provider]).toBe(true);
    }
  });

  it("treats local Whisper as desktop-only rather than coming soon cloud", () => {
    expect(PROVIDER_TYPE_COMING_SOON[PROVIDER_TYPES.localWhisper]).toBe(false);
    expect(CLOUD_CATALOG_PROVIDERS).not.toContain(PROVIDER_TYPES.localWhisper);
  });
});

it('gates every provider independently and fails closed for unknown types', () => {
  for (const provider of Object.values(PROVIDER_TYPES)) {
    expect(isProviderVisible(provider, () => false)).toBe(false);
    expect(isProviderVisible(provider, key => key === PROVIDER_FEATURE_KEYS[provider])).toBe(true);
  }
  expect(isProviderVisible('unknown-provider', () => true)).toBe(false);
});
