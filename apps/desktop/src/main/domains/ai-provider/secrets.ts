import type { AiProviderKind } from '@prismical/desktop-contracts';

/**
 * The SecureStore slot holding a provider's API key. One slot
 * per provider kind so switching providers never asks for a key twice. Written
 * by the capability:setAiProviderKey IPC handler, read by AiProviderLive; the
 * value never reaches the renderer and is never logged.
 */
export const aiProviderSecretKey = (provider: AiProviderKind): string => `ai.${provider}.apiKey`;
