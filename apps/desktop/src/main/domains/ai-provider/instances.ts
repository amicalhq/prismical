import type { AiProviderKind } from '@prismical/desktop-contracts';

/**
 * The synthetic `instance` rows local mode serves on GET /apps/v1/me/instances:
 * one per configured provider, addressed by a fixed id so
 * the renderer's persisted model pick (`ask.model.v1` in localStorage) and the
 * formatting default survive restarts. Not `inst_`+cuid like core's rows —
 * the prefix is kept so client-side id checks still pass.
 */
const LOCAL_INSTANCE_PREFIX = 'inst_local_';

export const AI_PROVIDER_KINDS: ReadonlyArray<AiProviderKind> = [
  'openai',
  'anthropic',
  'openai-compatible',
  'ollama',
];

export const localInstanceId = (provider: AiProviderKind): string =>
  `${LOCAL_INSTANCE_PREFIX}${provider}`;

export const providerOfInstanceId = (instanceId: string): AiProviderKind | null => {
  if (!instanceId.startsWith(LOCAL_INSTANCE_PREFIX)) return null;
  const kind = instanceId.slice(LOCAL_INSTANCE_PREFIX.length);
  return (AI_PROVIDER_KINDS as ReadonlyArray<string>).includes(kind)
    ? (kind as AiProviderKind)
    : null;
};

export const PROVIDER_LABELS: Record<AiProviderKind, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  'openai-compatible': 'OpenAI-compatible',
  ollama: 'Ollama',
};
