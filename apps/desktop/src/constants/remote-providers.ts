export const REMOTE_PROVIDERS = {
  openRouter: "OpenRouter",
  ollama: "Ollama",
  openAICompatible: "OpenAI Compatible",
  mock: "Mock",
} as const;

export type RemoteProvider =
  (typeof REMOTE_PROVIDERS)[keyof typeof REMOTE_PROVIDERS];
