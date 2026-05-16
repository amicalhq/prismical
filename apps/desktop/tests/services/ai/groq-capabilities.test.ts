import { describe, expect, it } from "vitest";

import { groqSupportsStrictJsonSchema } from "@/services/ai/groq-capabilities";

describe("groq-capabilities", () => {
  it("allows known strict-schema-capable model families (vendor-prefixed where Groq returns them that way)", () => {
    expect(groqSupportsStrictJsonSchema("moonshotai/kimi-k2-instruct-0905")).toBe(true);
    expect(
      groqSupportsStrictJsonSchema("meta-llama/llama-4-scout-17b-16e-instruct"),
    ).toBe(true);
    // Qwen3 ships as `qwen/qwen3-32b` from Groq's catalog — not bare `qwen3-`.
    expect(groqSupportsStrictJsonSchema("qwen/qwen3-32b")).toBe(true);
    expect(groqSupportsStrictJsonSchema("qwen-qwq-32b")).toBe(true);
    expect(groqSupportsStrictJsonSchema("openai/gpt-oss-20b")).toBe(true);
    expect(groqSupportsStrictJsonSchema("openai/gpt-oss-120b")).toBe(true);
    expect(groqSupportsStrictJsonSchema("deepseek-r1-distill-qwen-32b")).toBe(true);
  });

  it("rejects models known not to support json_schema", () => {
    // gemma2-9b-it only supports json_object — runner sets
    // structuredOutputs:false for it.
    expect(groqSupportsStrictJsonSchema("gemma2-9b-it")).toBe(false);
    // Older Llama 3.1 8B instant variant
    expect(groqSupportsStrictJsonSchema("llama-3.1-8b-instant")).toBe(false);
    // Llama 3.3 — verified 2026-05 via live smoke-test: Groq rejects
    // `response_format: json_schema` for `llama-3.3-70b-versatile`.
    expect(groqSupportsStrictJsonSchema("llama-3.3-70b-versatile")).toBe(false);
  });

  it("returns false for unknown ids (conservative default)", () => {
    expect(groqSupportsStrictJsonSchema("some-unreleased-model")).toBe(false);
    expect(groqSupportsStrictJsonSchema("")).toBe(false);
  });

  it("matches prefixes case-insensitively", () => {
    expect(groqSupportsStrictJsonSchema("META-LLAMA/Llama-4-Scout-17B")).toBe(true);
  });
});
