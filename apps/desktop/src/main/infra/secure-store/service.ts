import { Context, Data, type Effect } from 'effect';
import type { DbError } from '../operational-db/service';

export class SecureStoreError extends Data.TaggedError('SecureStoreError')<{
  readonly reason: 'unavailable' | 'decrypt-failed';
  readonly cause?: unknown;
}> {}

/**
 * safeStorage wrapper. Ciphertext lives in the operational settings
 * table under the `secure:` key prefix; plaintext never touches disk or logs.
 */
export interface SecureStoreService {
  readonly setSecret: (key: string, value: string) => Effect.Effect<void, SecureStoreError | DbError>;
  readonly getSecret: (key: string) => Effect.Effect<string | null, SecureStoreError | DbError>;
  readonly deleteSecret: (key: string) => Effect.Effect<void, DbError>;
}

export class SecureStore extends Context.Tag('desktop/SecureStore')<SecureStore, SecureStoreService>() {}

export const SECURE_KEY_PREFIX = 'secure:';
