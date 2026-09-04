import { Context, Data } from 'effect';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './schema';

export class ProductDbError extends Data.TaggedError('ProductDbError')<{
  readonly op: string;
  readonly cause: unknown;
}> {}

/**
 * Which product store to open (one schema, two stores). `local` is the
 * local-mode local.db; `cloud-cache` is the per-(sub, org) cache file under
 * AppConfig.cloudCacheDir. The file boundary IS the policy boundary — rows
 * carry no owner/org columns, the target picks the file.
 */
export type ProductDbTarget =
  | { readonly kind: 'local' }
  | { readonly kind: 'cloud-cache'; readonly sub: string; readonly orgId?: string };

export interface ProductDbService {
  /** Drizzle handle typed against the product schema — later stages build typed ops on it. */
  readonly db: BetterSQLite3Database<typeof schema>;
  /**
   * Raw better-sqlite3 handle — for SQL drizzle cannot express (note_fts MATCH
   * queries) and multi-statement transactions.
   */
  readonly client: Database.Database;
}

export class ProductDb extends Context.Tag('desktop/ProductDb')<ProductDb, ProductDbService>() {}
