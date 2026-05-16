import { logger } from "@/main/logger";

// The AI SDK reads `globalThis.AI_SDK_LOG_WARNINGS` (LogWarningsFunction)
// and falls back to logging warnings via console.warn. We forward warnings
// to our structured pipeline logger so they show up alongside skill / note
// telemetry — this is how we observe what the native providers stripped
// (e.g. "temperature is not supported by this model" for OpenAI o3-mini).
//
// One-shot global registration: call from main-process startup. Idempotent.

let registered = false;

export function registerSdkWarningHandler(): void {
  if (registered) return;
  registered = true;

  // Augment globalThis to avoid `any` at the assignment site. The SDK
  // declares `var AI_SDK_LOG_WARNINGS: LogWarningsFunction | undefined |
  // false;` so the type already exists in `globalThis`.
  // SharedV3Warning union: { type: 'unsupported' | 'compatibility', feature, details? } | { type: 'other', message }.
  globalThis.AI_SDK_LOG_WARNINGS = ({ warnings, provider, model }) => {
    if (warnings.length === 0) return;
    logger.pipeline.warn("AI SDK provider warnings", {
      provider,
      modelId: model,
      warnings: warnings.map((w) =>
        w.type === "other"
          ? { type: w.type, message: w.message }
          : { type: w.type, feature: w.feature, details: w.details },
      ),
    });
  };
}
