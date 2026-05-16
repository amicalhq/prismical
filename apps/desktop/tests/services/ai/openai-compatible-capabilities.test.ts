import { describe, expect, it } from "vitest";

import {
  classifyOpenAICompatibleModel,
  compatCapabilityTransform,
} from "@/services/ai/openai-compatible-capabilities";

describe("openai-compatible-capabilities", () => {
  describe("classifyOpenAICompatibleModel", () => {
    it("flags o-series as reasoning + applies max_tokens rename", () => {
      for (const id of ["o1", "o3-mini", "o4-mini-2025-11-01"]) {
        const caps = classifyOpenAICompatibleModel(id);
        expect(caps.isReasoning).toBe(true);
        expect(caps.supportsTemperature).toBe(false);
        expect(caps.supportsTopP).toBe(false);
        expect(caps.paramRenames.max_tokens).toBe("max_completion_tokens");
      }
    });

    it("flags gpt-5 + gpt-oss as reasoning", () => {
      expect(classifyOpenAICompatibleModel("gpt-5").isReasoning).toBe(true);
      expect(classifyOpenAICompatibleModel("gpt-5.1-Codex-Max").isReasoning).toBe(true);
      expect(classifyOpenAICompatibleModel("openai/gpt-oss-20b").isReasoning).toBe(true);
    });

    it("flags deepseek-r1, qwen-qwq, qwen3 families as reasoning", () => {
      expect(classifyOpenAICompatibleModel("deepseek-r1-distill-qwen-32b").isReasoning).toBe(true);
      expect(classifyOpenAICompatibleModel("qwen-qwq-32b").isReasoning).toBe(true);
      expect(classifyOpenAICompatibleModel("qwen3-32b").isReasoning).toBe(true);
    });

    it("keeps non-reasoning gpt-4 / 3.5 chat models intact but renames max_tokens", () => {
      const gpt4 = classifyOpenAICompatibleModel("gpt-4o-mini");
      expect(gpt4.isReasoning).toBe(false);
      expect(gpt4.supportsTemperature).toBe(true);
      expect(gpt4.paramRenames.max_tokens).toBe("max_completion_tokens");
    });

    it("returns full-support default for unrecognised model ids", () => {
      const llama = classifyOpenAICompatibleModel("llama-3.3-70b-versatile");
      expect(llama.isReasoning).toBe(false);
      expect(llama.supportsTemperature).toBe(true);
      expect(llama.supportsTopP).toBe(true);
      expect(llama.paramRenames).toEqual({});
    });
  });

  describe("compatCapabilityTransform", () => {
    it("strips sampling knobs from reasoning-model bodies + renames max_tokens", () => {
      const out = compatCapabilityTransform({
        model: "o3-mini",
        temperature: 0.1,
        top_p: 0.9,
        frequency_penalty: 0,
        presence_penalty: 0,
        max_tokens: 1000,
        messages: [],
      });
      expect(out.temperature).toBeUndefined();
      expect(out.top_p).toBeUndefined();
      expect(out.frequency_penalty).toBeUndefined();
      expect(out.presence_penalty).toBeUndefined();
      expect(out.max_tokens).toBeUndefined();
      expect(out.max_completion_tokens).toBe(1000);
      expect(out.messages).toEqual([]);
    });

    it("keeps sampling knobs for non-reasoning models", () => {
      const out = compatCapabilityTransform({
        model: "llama-3.3-70b-versatile",
        temperature: 0.7,
        top_p: 0.95,
        max_tokens: 800,
      });
      expect(out.temperature).toBe(0.7);
      expect(out.top_p).toBe(0.95);
      // No rename for non-OpenAI chat ids.
      expect(out.max_tokens).toBe(800);
      expect(out.max_completion_tokens).toBeUndefined();
    });

    it("renames max_tokens for OpenAI gpt-4 family even without other changes", () => {
      const out = compatCapabilityTransform({
        model: "gpt-4o",
        max_tokens: 500,
        temperature: 0.5,
      });
      expect(out.max_tokens).toBeUndefined();
      expect(out.max_completion_tokens).toBe(500);
      expect(out.temperature).toBe(0.5);
    });

    it("handles bodies with no model field as default capabilities", () => {
      const out = compatCapabilityTransform({
        temperature: 0.7,
        max_tokens: 100,
      });
      expect(out.temperature).toBe(0.7);
      expect(out.max_tokens).toBe(100);
    });
  });
});
