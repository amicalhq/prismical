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
 * IMPORTANT: providers are constructed via `providerFactories` from
 * `src/services/ai/provider-config.ts` — the same closures the production
 * registry uses. So this exercises real wrappers (extractJsonMiddleware,
 * User-Agent, OpenRouter usage middleware + app attribution,
 * compatCapabilityTransform), not bare vendor SDKs. A green run actually
 * means the production wiring works against live providers.
 *
 * Not part of CI. On-demand only — running against real providers in PR
 * runs would burn money and surface flaky-provider noise that isn't ours.
 */

import {
  generateText,
  Output,
  extractJsonMiddleware,
  wrapLanguageModel,
} from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { z } from "zod";

import {
  PROVIDER_TYPES,
  type ProviderType,
} from "../src/constants/provider-types";
import { providerFactories } from "../src/services/ai/provider-config";
import type { InstanceConfig } from "../src/db/schema";

interface MatrixEntry {
  provider: ProviderType;
  envVar: string;
  models: string[];
  configFromEnv: (envValue: string) => InstanceConfig;
}

const MATRIX: MatrixEntry[] = [
  {
    provider: PROVIDER_TYPES.openai,
    envVar: "OPENAI_API_KEY",
    models: ["gpt-4o-mini"],
    configFromEnv: (apiKey) => ({ apiKey }),
  },
  {
    provider: PROVIDER_TYPES.anthropic,
    envVar: "ANTHROPIC_API_KEY",
    models: ["claude-haiku-4-5"],
    configFromEnv: (apiKey) => ({ apiKey }),
  },
  {
    provider: PROVIDER_TYPES.groq,
    envVar: "GROQ_API_KEY",
    models: ["llama-3.3-70b-versatile"],
    configFromEnv: (apiKey) => ({ apiKey }),
  },
  {
    provider: PROVIDER_TYPES.openRouter,
    envVar: "OPENROUTER_API_KEY",
    models: ["openai/gpt-4o-mini"],
    configFromEnv: (apiKey) => ({ apiKey }),
  },
  {
    provider: PROVIDER_TYPES.ollama,
    envVar: "OLLAMA_HOST",
    models: ["llama3.2"],
    configFromEnv: (host) => ({ url: host }),
  },
];

interface Result {
  provider: string;
  model: string;
  plain: { ok: boolean; ms: number; error?: string };
  structured: { ok: boolean; ms: number; error?: string };
}

function buildModel(entry: MatrixEntry, envValue: string, modelId: string) {
  const factory = providerFactories[entry.provider];
  if (!factory) {
    throw new Error(
      `providerFactories has no entry for ${entry.provider}; matrix is out of sync`,
    );
  }
  const provider = factory(entry.configFromEnv(envValue));
  return provider.languageModel(modelId);
}

async function runPlain(model: LanguageModelV3): Promise<Result["plain"]> {
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
  model: LanguageModelV3,
): Promise<Result["structured"]> {
  // Wrap with extractJsonMiddleware — matches the skill-runner's production
  // path. Without this, a Groq model returning fenced JSON would fail here
  // even though it succeeds in production.
  const wrapped = wrapLanguageModel({
    model,
    middleware: extractJsonMiddleware(),
  });
  const start = Date.now();
  try {
    const result = await generateText({
      model: wrapped,
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
      const model = buildModel(entry, cred, modelId);
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
