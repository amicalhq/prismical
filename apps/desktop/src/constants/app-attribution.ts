// Identity strings the app sends with outbound LLM requests so vendor
// dashboards (e.g. openrouter.ai/activity) attribute usage to Prismical.
// Centralised so multiple providers can share the same values without
// drifting — pass these into `createOpenRouter`, future `@ai-sdk/google`
// app-id headers, Anthropic User-Agent suffixes, etc.

export const APP_NAME = "Prismical";
export const APP_URL = "https://prismical.ai";
