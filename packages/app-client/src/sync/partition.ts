/**
 * Sync-store partitioning. Every persisted byte of the Legend-State
 * sync layer is scoped to one (account sub, org id) identity: each partition
 * gets its own IndexedDB DATABASE, so cross-account/org reads are impossible
 * by construction and purge = deleteDatabase.
 *
 * The database name embeds a HASH of the identity, not the identity itself:
 * OAuth subs routinely contain characters that are hostile outside their own
 * context (`provider|id`), and the raw identity has no business appearing in
 * storage keys. FNV-1a 64-bit is plenty for a handful of identities per
 * machine and is synchronous (crypto.subtle is async, which would poison the
 * store construction path).
 */
export interface SyncPartition {
  readonly accountSub: string;
  readonly orgId: string;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

function fnv1a64(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Stable opaque key for a partition ("\0" separator — cannot occur in ids). */
export function partitionKey(partition: SyncPartition): string {
  return fnv1a64(`${partition.accountSub}\0${partition.orgId}`);
}

/** The partition's IndexedDB database name. Purging the partition = deleting this database. */
export function partitionDatabaseName(partition: SyncPartition): string {
  return `prismical-sync-${partitionKey(partition)}`;
}

/** Sync collection tables — the IndexedDB plugin pre-declares its object stores. */
export const SYNC_TABLE_NAMES = ["notes", "folders", "tags", "noteTags", "noteEvents"] as const;
export type SyncTableName = (typeof SYNC_TABLE_NAMES)[number];

/** Bump to drop-and-rebuild every partition (schema/format change). Rebuild-only — never scheduled. */
// 2: noteEvents object store (note↔calendar-event links).
export const SYNC_DB_VERSION = 2;
