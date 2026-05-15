#!/usr/bin/env tsx
/*
 * Live provider smoke test (t-13).
 *
 * Run: `pnpm test:providers:live` from repo root, which wraps the script
 * with `infisical run --env=dev` to inject API keys. Without infisical the
 * script still works — it reads `process.env.<PROVIDER>_API_KEY` and skips
 * any provider whose key isn't present.
 *
 * Each (provider, model) pair in MATRIX runs twice: once plain (just say
 * "OK") and once with a strict structured-output schema. The script prints
 * a markdown table summary suitable for pasting into a PR comment.
 *
 * Not part of CI. On-demand only — running this in PR CI burns money and
 * surfaces flaky-provider noise that isn't our bug.
 */

import { generateText, Output } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";

interface MatrixEntry {
  provider: string;
  envVar: string;
  models: string[];
  build: (apiKey: string, modelId: string) => unknown;
}

const MATRIX: MatrixEntry[] = [
  {
    provider: "openai",
    envVar: "OPENAI_API_KEY",
    models: ["gpt-4o-mini"],
    build: (apiKey, modelId) =>
      createOpenAI({ apiKey }).languageModel(modelId),
  },
  {
    provider: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    models: ["claude-haiku-4-5"],
    build: (apiKey, modelId) =>
      createAnthropic({ apiKey }).languageModel(modelId),
  },
  {
    provider: "groq",
    envVar: "GROQ_API_KEY",
    models: ["llama-3.3-70b-versatile"],
    build: (apiKey, modelId) => createGroq({ apiKey }).languageModel(modelId),
  },
  {
    provider: "openrouter",
    envVar: "OPENROUTER_API_KEY",
    models: ["openai/gpt-4o-mini"],
    build: (apiKey, modelId) =>
      createOpenRouter({
        apiKey,
        appName: "Prismical (live test)",
        appUrl: "https://prismical.ai",
      }).languageModel(modelId),
  },
  {
    provider: "ollama",
    envVar: "OLLAMA_HOST",
    models: ["llama3.2"],
    build: (host, modelId) =>
      createOpenAICompatible({
        name: "ollama",
        baseURL: `${host.replace(/\/+$/, "")}/v1`,
        supportsStructuredOutputs: true,
      }).languageModel(modelId),
  },
];

interface Result {
  provider: string;
  model: string;
  plain: { ok: boolean; ms: number; error?: string };
  structured: { ok: boolean; ms: number; error?: string };
}

async function runPlain(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any,
): Promise<Result["plain"]> {
  const start = Date.now();
  try {
    const result = await generateText({
      model,
      prompt: 'Reply with the single word "OK" and nothing else.',
    });
    const ms = Date.now() - start;
    const ok = result.text.trim().toUpperCase().startsWith("OK");
    return { ok, ms, error: ok ? undefined : `text=${result.text.slice(0, 60)}` };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function runStructured(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any,
): Promise<Result["structured"]> {
  const start = Date.now();
  try {
    const result = await generateText({
      model,
      prompt: 'Return JSON with a single field `word` containing "hello".',
      output: Output.object({ schema: z.object({ word: z.string() }) }),
    });
    const ms = Date.now() - start;
    const ok = typeof result.output.word === "string";
    return {
      ok,
      ms,
      error: ok ? undefined : `output=${JSON.stringify(result.output)}`,
    };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function main() {
  const results: Result[] = [];
  for (const entry of MATRIX) {
    const cred = process.env[entry.envVar];
    if (!cred) {
      console.warn(
        `⚠️  Skipping ${entry.provider}: ${entry.envVar} not set in env`,
      );
      continue;
    }
    for (const modelId of entry.models) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const model = entry.build(cred, modelId) as any;
      const plain = await runPlain(model);
      const structured = await runStructured(model);
      results.push({ provider: entry.provider, model: modelId, plain, structured });
      const label = `${entry.provider}/${modelId}`;
      const plainStatus = plain.ok ? "✅" : "❌";
      const structuredStatus = structured.ok ? "✅" : "❌";
      console.log(
        `${plainStatus} ${label} · plain ${plain.ms}ms · ${structuredStatus} structured ${structured.ms}ms${plain.ok ? "" : ` · ${plain.error}`}${structured.ok ? "" : ` · ${structured.error}`}`,
      );
    }
  }

  // Markdown summary for PR pasting.
  console.log("\n## Live provider matrix\n");
  console.log("| Provider | Model | Plain | Structured |");
  console.log("| --- | --- | --- | --- |");
  for (const r of results) {
    const p = r.plain.ok ? `✅ ${r.plain.ms}ms` : `❌ ${r.plain.error}`;
    const s = r.structured.ok
      ? `✅ ${r.structured.ms}ms`
      : `❌ ${r.structured.error}`;
    console.log(`| ${r.provider} | \`${r.model}\` | ${p} | ${s} |`);
  }

  const anyFail = results.some((r) => !r.plain.ok || !r.structured.ok);
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
