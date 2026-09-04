import { describe, expect, it } from "vitest";
import {
  CLOUD_CATALOG_PROVIDERS,
  HIDDEN_PROVIDER_TYPES,
  PROVIDER_TYPE_COMING_SOON,
  PROVIDER_TYPES,
} from "./providers";

describe("AI provider availability", () => {
  it("keeps every product provider visible", () => {
    expect(HIDDEN_PROVIDER_TYPES.size).toBe(0);
  });

  it("enables only cloud providers backed by the core catalog", () => {
    expect(CLOUD_CATALOG_PROVIDERS).toEqual([
      PROVIDER_TYPES.openai,
      PROVIDER_TYPES.openRouter,
      PROVIDER_TYPES.googleGemini,
    ]);
    for (const provider of CLOUD_CATALOG_PROVIDERS) {
      expect(PROVIDER_TYPE_COMING_SOON[provider]).toBe(false);
    }
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
