import { getUserAgent } from "../utils/http-client";
import {
  normalizeOllamaUrl,
  normalizeOpenAICompatibleBaseURL,
} from "../utils/provider-utils";
import {
  PROVIDER_TYPES,
  isProviderType,
  type ProviderType,
} from "../constants/provider-types";
import type {
  ApiKeyConfig,
  InstanceConfig,
  OllamaConfig,
  OpenAICompatibleConfig,
} from "../db/schema";

// Per-type credential validation. Called by the tRPC instances router
// before persisting a create/update. Throws nothing — every validator
// returns a `ValidationResult` so the UI can render the failure cause.

export interface ValidationResult {
  success: boolean;
  error?: string;
}

/**
 * Validate an instance config against the provider's live endpoint.
 * Dispatches by provider and narrows the JSON config to the expected
 * shape. Singleton providers (local-whisper, mock) always succeed —
 * there's nothing remote to validate.
 */
export async function validateInstanceConfig(
  provider: string,
  config: InstanceConfig,
): Promise<ValidationResult> {
  if (!isProviderType(provider)) {
    return { success: false, error: `Unknown provider: ${provider}` };
  }
  const p: ProviderType = provider;
  switch (p) {
    case PROVIDER_TYPES.openai:
      return validateOpenAI(config as ApiKeyConfig);
    case PROVIDER_TYPES.anthropic:
      return validateAnthropic(config as ApiKeyConfig);
    case PROVIDER_TYPES.groq:
      return validateGroq(config as ApiKeyConfig);
    case PROVIDER_TYPES.openRouter:
      return validateOpenRouter(config as ApiKeyConfig);
    case PROVIDER_TYPES.ollama:
      return validateOllama(config as OllamaConfig);
    case PROVIDER_TYPES.openAICompatible:
      return validateOpenAICompatible(config as OpenAICompatibleConfig);
    case PROVIDER_TYPES.localWhisper:
    case PROVIDER_TYPES.mock:
      return { success: true };
    case PROVIDER_TYPES.googleGemini:
    case PROVIDER_TYPES.vercelAIGateway:
    case PROVIDER_TYPES.cloudflareWorkersAI:
    case PROVIDER_TYPES.cerebras:
      // Coming-soon placeholders — UI marks the tile as disabled, but
      // surface a clear error if someone reaches the validator anyway.
      return {
        success: false,
        error: `${p} isn't supported yet — provider listed as "Coming soon"`,
      };
    default: {
      const exhaustive: never = p;
      return {
        success: false,
        error: `No validator for provider: ${exhaustive}`,
      };
    }
  }
}

// ---------- Bearer-key shape providers ----------

async function validateOpenAI(
  config: ApiKeyConfig,
): Promise<ValidationResult> {
  return validateBearerEndpoint(
    "https://api.openai.com/v1/models",
    config.apiKey,
  );
}

async function validateGroq(config: ApiKeyConfig): Promise<ValidationResult> {
  return validateBearerEndpoint(
    "https://api.groq.com/openai/v1/models",
    config.apiKey,
  );
}

async function validateOpenRouter(
  config: ApiKeyConfig,
): Promise<ValidationResult> {
  return validateBearerEndpoint(
    "https://openrouter.ai/api/v1/key",
    config.apiKey,
  );
}

/**
 * Anthropic exposes a free `GET /v1/models` endpoint (uses x-api-key, not
 * bearer, so we can't reuse `validateBearerEndpoint`). We do a real
 * round-trip with limit=1 so a typo'd or revoked key is caught at
 * configure time rather than first inference.
 */
async function validateAnthropic(
  config: ApiKeyConfig,
): Promise<ValidationResult> {
  if (!config.apiKey || !config.apiKey.trim()) {
    return { success: false, error: "API key is required" };
  }
  if (!config.apiKey.trim().startsWith("sk-ant-")) {
    return {
      success: false,
      error: 'Anthropic API keys start with "sk-ant-"',
    };
  }
  try {
    const response = await fetch(
      "https://api.anthropic.com/v1/models?limit=1",
      {
        method: "GET",
        headers: {
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
          "User-Agent": getUserAgent(),
        },
      },
    );
    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      const message =
        errorData?.error?.message ??
        `HTTP ${response.status}: ${response.statusText}`;
      return { success: false, error: message };
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Connection failed",
    };
  }
}

// ---------- Provider-specific shapes ----------

async function validateOllama(
  config: OllamaConfig,
): Promise<ValidationResult> {
  try {
    const cleanUrl = normalizeOllamaUrl(config.url);
    if (!cleanUrl) return { success: false, error: "URL is required" };
    const response = await fetch(`${cleanUrl}/api/version`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": getUserAgent(),
      },
    });
    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to connect to Ollama. Make sure Ollama is running.",
    };
  }
}

async function validateOpenAICompatible(
  config: OpenAICompatibleConfig,
): Promise<ValidationResult> {
  const baseURL = normalizeOpenAICompatibleBaseURL(config.baseURL);
  if (!baseURL) return { success: false, error: "Base URL is required" };
  if (!config.apiKey || !config.apiKey.trim()) {
    return { success: false, error: "API key is required" };
  }
  return validateBearerEndpoint(`${baseURL}/models`, config.apiKey);
}

// ---------- Helpers ----------

async function validateBearerEndpoint(
  url: string,
  apiKey: string,
): Promise<ValidationResult> {
  if (!apiKey || !apiKey.trim()) {
    return { success: false, error: "API key is required" };
  }
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": getUserAgent(),
      },
    });
    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      const message =
        errorData?.error?.message ??
        `HTTP ${response.status}: ${response.statusText}`;
      return { success: false, error: message };
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Connection failed",
    };
  }
}
