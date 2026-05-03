export function isOllamaEmbeddingModelName(name: string): boolean {
  return name.toLowerCase().includes("embed");
}

export function normalizeOllamaUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function normalizeOpenAICompatibleBaseURL(baseURL: string): string {
  const normalized = baseURL.trim().replace(/\/+$/, "");
  if (!normalized) {
    return normalized;
  }

  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}
