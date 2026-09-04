/**
 * Product store — file-backed SQLite opened per workspace scope:
 * local mode opens local.db at AppConfig.localDbPath; cloud mode opens the
 * per-(sub, org) cache file under AppConfig.cloudCacheDir. Same acquire /
 * release discipline as the operational store (Effect.acquireRelease, closed
 * on release, client closed on migration failure). Open failure is a
 * WORKSPACE acquire failure (tagged ProductDbError), not a BootError — the
 * product DB lives inside the workspace scope, not at boot.
 *
 * Driver: better-sqlite3 over drizzle-orm/better-sqlite3 — the same rollup
 * external / EXTERNAL_DEPENDENCIES closure the operational store already
 * ships with.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { Effect, Layer } from 'effect';
import { AppConfig, type AppConfigService } from '../config/service';
import { MainLogger } from '../logging/service';
import { applyProductMigrations } from './migrations';
import * as schema from './schema';
import {
  ProductDb,
  ProductDbError,
  type ProductDbService,
  type ProductDbTarget,
} from './service';

const openDatabase = (dbPath: string): Database.Database => {
  if (dbPath === ':memory:') {
    return new Database(':memory:');
  }
  // The cloud-cache filename is used literally — better-sqlite3 takes a plain
  // path, so the '%' from encodeURIComponent needs no escaping.
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const client = new Database(dbPath);
  try {
    // better-sqlite3 defaults journal_mode to `delete` for a new file — keep
    // WAL, matching the operational store.
    client.pragma('journal_mode = WAL');
  } catch (error) {
    client.close();
    throw error;
  }
  return client;
};

/**
 * Resolves the target's database file from AppConfig. Cache filenames encode
 * each identity component (no ':' — Windows) and fold a missing orgId to
 * 'default', mirroring the eventkit sequence-key idiom.
 */
const resolveDbPath = (config: AppConfigService, target: ProductDbTarget): string =>
  target.kind === 'local'
    ? config.localDbPath
    : path.join(
        config.cloudCacheDir,
        `${encodeURIComponent(target.sub)}__${encodeURIComponent(target.orgId ?? 'default')}.db`
      );

/** 6-char identity prefix — the redaction idiom the auth domain's logs use. */
const idPrefix = (value: string): string => value.slice(0, 6) + '…';

/**
 * What this store may say about itself in a log line. A cloud-cache FILENAME
 * embeds the account sub and the org id, and these lines ship inside the
 * user-exported log bundle (attached to public issues in the OSS lane) — so
 * only the local path, which carries no identity, is ever logged verbatim.
 */
const describeTarget = (dbPath: string, target: ProductDbTarget): Record<string, unknown> =>
  target.kind === 'local'
    ? { target: 'local', path: dbPath }
    : {
        target: 'cloud-cache',
        sub: idPrefix(target.sub),
        orgId: target.orgId === undefined ? null : idPrefix(target.orgId),
      };

/**
 * Same rule for FAILURES. The workspace loop reports an open failure as
 * `<op>: <cause>` (workspace-lifecycle.ts), so a cloud-cache cause is rendered
 * here as `cloud-cache <sub…>/<org…>: <driver message>` — the target label
 * already redacted, so operators still see WHICH cache failed. The local
 * store's path carries no identity, so its cause passes through untouched
 * (the SqliteError keeps its code and stack). better-sqlite3's own messages
 * carry no path, but the scrub of the identity components (raw AND
 * percent-encoded, as the filename holds them) stays as a defence should a
 * driver or fs error ever quote one.
 *
 * @internal exported for the redaction test only.
 */
export const redactCause = (target: ProductDbTarget, cause: unknown): unknown => {
  if (target.kind === 'local') return cause;
  let text = String(cause);
  const identities = target.orgId === undefined ? [target.sub] : [target.sub, target.orgId];
  for (const value of identities) {
    for (const form of [value, encodeURIComponent(value)]) {
      if (form.length > 0) text = text.split(form).join(idPrefix(value));
    }
  }
  const orgId = target.orgId === undefined ? 'none' : idPrefix(target.orgId);
  return `cloud-cache ${idPrefix(target.sub)}/${orgId}: ${text}`;
};

export const makeProductDbLayer = (
  target: ProductDbTarget
): Layer.Layer<ProductDb, ProductDbError, AppConfig | MainLogger> =>
  Layer.scoped(
    ProductDb,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const log = (yield* MainLogger).scoped('product-db');
      const dbPath = resolveDbPath(config, target);

      const handle = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const client = openDatabase(dbPath);
            try {
              const ran = applyProductMigrations(client);
              return { client, ran };
            } catch (error) {
              client.close();
              throw error;
            }
          },
          catch: cause => new ProductDbError({ op: 'open', cause: redactCause(target, cause) }),
        }).pipe(
          Effect.tap(({ ran }) =>
            log.info('product db opened', {
              ...describeTarget(dbPath, target),
              migrationsRun: ran,
            })
          )
        ),
        ({ client }) =>
          Effect.sync(() => {
            client.close();
          }).pipe(Effect.zipRight(log.info('product db closed')))
      );

      const db = drizzle(handle.client, { schema });

      const service: ProductDbService = { db, client: handle.client };
      return service;
    })
  );
