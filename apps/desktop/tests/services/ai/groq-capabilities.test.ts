import { describe, expect, it } from "vitest";

import { groqSupportsStrictJsonSchema } from "@/services/ai/groq-capabilities";

describe("groq-capabilities", () => {
  it("allows known strict-schema-capable model families", () => {
    expect(groqSupportsStrictJsonSchema("moonshotai/kimi-k2-instruct-0905")).toBe(true);
    expect(groqSupportsStrictJsonSchema("meta-llama/llama-4-scout-17b")).toBe(true);
    expect(groqSupportsStrictJsonSchema("llama-3.3-70b-versatile")).toBe(true);
    expect(groqSupportsStrictJsonSchema("qwen3-32b")).toBe(true);
    expect(groqSupportsStrictJsonSchema("qwen-qwq-32b")).toBe(true);
    expect(groqSupportsStrictJsonSchema("openai/gpt-oss-20b")).toBe(true);
    expect(groqSupportsStrictJsonSchema("deepseek-r1-distill-qwen-32b")).toBe(true);
  });

  it("rejects models known not to support json_schema", () => {
    // gemma2-9b-it only supports json_object — runner sets
    // structuredOutputs:false for it.
    expect(groqSupportsStrictJsonSchema("gemma2-9b-it")).toBe(false);
    // Older Llama 3.1 8B instant variant
    expect(groqSupportsStrictJsonSchema("llama-3.1-8b-instant")).toBe(false);
  });

  it("returns false for unknown ids (conservative default)", () => {
    expect(groqSupportsStrictJsonSchema("some-unreleased-model")).toBe(false);
    expect(groqSupportsStrictJsonSchema("")).toBe(false);
  });

  it("matches prefixes case-insensitively", () => {
    expect(groqSupportsStrictJsonSchema("META-LLAMA/Llama-4-Scout-17B")).toBe(true);
  });
});
