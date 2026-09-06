/** The endpoint and its credential share one encrypted SecureStore value. */
export const BYOK_API_KEY_SECRET = 'transcription.byok.apiKey';

const normalizedBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, '');

export const encodeByokCredential = (baseUrl: string, key: string): string =>
  JSON.stringify({ baseUrl: normalizedBaseUrl(baseUrl), key });

/** Unbound or differently owned keys must never follow a frozen recording endpoint. */
export const byokKeyForEndpoint = (
  secret: string | null,
  baseUrl: string | null
): string | null => {
  if (secret === null || baseUrl === null || normalizedBaseUrl(baseUrl) === '') return null;
  try {
    const credential: unknown = JSON.parse(secret);
    if (typeof credential !== 'object' || credential === null) return null;
    const { baseUrl: storedBaseUrl, key } = credential as Record<string, unknown>;
    return typeof storedBaseUrl === 'string' &&
      normalizedBaseUrl(storedBaseUrl) === normalizedBaseUrl(baseUrl) &&
      typeof key === 'string' &&
      key.length > 0
      ? key
      : null;
  } catch {
    return null;
  }
};
