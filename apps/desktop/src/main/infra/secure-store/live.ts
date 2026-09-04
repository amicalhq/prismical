import { safeStorage } from 'electron';
import { Effect, Layer } from 'effect';
import { BootError } from '../../runtime/boot-error';
import { AppConfig } from '../config/service';
import { ElectronApp } from '../electron/service';
import { MainLogger } from '../logging/service';
import { OperationalDb } from '../operational-db/service';
import {
  SECURE_KEY_PREFIX,
  SecureStore,
  SecureStoreError,
  type SecureStoreService,
} from './service';

interface Codec {
  readonly name: string;
  readonly encrypt: (plaintext: string) => string; // → base64 payload for the settings table
  readonly decrypt: (payload: string) => string;
}

const safeStorageCodec: Codec = {
  name: 'safeStorage',
  encrypt: plaintext => safeStorage.encryptString(plaintext).toString('base64'),
  decrypt: payload => safeStorage.decryptString(Buffer.from(payload, 'base64')),
};

/**
 * E2E-only fake: deterministic reversible encoding so CI runs (isolated
 * profiles, no unlocked keychain) exercise the full store path. The `e2e:`
 * marker keeps a fake payload from ever being mistaken for real ciphertext.
 */
const e2eFakeCodec: Codec = {
  name: 'e2e-fake',
  encrypt: plaintext => Buffer.from(`e2e:${plaintext}`, 'utf8').toString('base64'),
  decrypt: payload => {
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    if (!decoded.startsWith('e2e:')) throw new Error('not an e2e-fake payload');
    return decoded.slice(4);
  },
};

export const SecureStoreLive: Layer.Layer<
  SecureStore,
  BootError,
  AppConfig | ElectronApp | OperationalDb | MainLogger
> = Layer.effect(
  SecureStore,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const electronApp = yield* ElectronApp;
    const store = yield* OperationalDb;
    const log = (yield* MainLogger).scoped('secure-store');

    // isEncryptionAvailable needs the ready app on some platforms.
    yield* electronApp.whenReady;

    const codec = yield* config.secureStoreMode === 'e2e-fake'
      ? Effect.succeed(e2eFakeCodec)
      : Effect.sync(() => safeStorage.isEncryptionAvailable()).pipe(
          Effect.filterOrFail(
            available => available,
            () =>
              new BootError({
                stage: 'secure-store',
                cause: new SecureStoreError({ reason: 'unavailable' }),
              })
          ),
          Effect.as(safeStorageCodec)
        );
    yield* log.info('secure store ready', { codec: codec.name });

    const settingKey = (key: string) => `${SECURE_KEY_PREFIX}${key}`;

    const service: SecureStoreService = {
      setSecret: (key, value) =>
        Effect.try({
          try: () => codec.encrypt(value),
          catch: cause => new SecureStoreError({ reason: 'unavailable', cause }),
        }).pipe(Effect.flatMap(payload => store.setSetting(settingKey(key), payload))),
      getSecret: key =>
        store.getSetting(settingKey(key)).pipe(
          Effect.flatMap(payload =>
            payload === null
              ? Effect.succeed(null)
              : Effect.try({
                  try: () => codec.decrypt(payload),
                  catch: cause => new SecureStoreError({ reason: 'decrypt-failed', cause }),
                })
          )
        ),
      deleteSecret: key => store.deleteSetting(settingKey(key)),
    };
    return service;
  })
);
