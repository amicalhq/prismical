/**
 * Partition purge. IndexedDB database names are opaque hashes of
 * (account sub, org id), so purging "everything for this sub" needs a
 * registry: each partition database records its owning sub in localStorage
 * when created. Sign-out deletes every database registered to the sub —
 * local product data (notes, bodies, cursors, pending writes) must not
 * survive a signed-out account.
 *
 * Deletion discards any queued offline writes for that account. Sign-out does this silently.
 */
const REGISTRY_KEY = "prismical-sync-partition-registry";

type Registry = Record<string, string>; // databaseName → accountSub

function readRegistry(): Registry {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(REGISTRY_KEY) ?? "{}") as Registry;
  } catch {
    return {};
  }
}

function writeRegistry(registry: Registry): void {
  try {
    globalThis.localStorage?.setItem(REGISTRY_KEY, JSON.stringify(registry));
  } catch {
    // Best-effort — a failed registry write only widens the purge-miss window.
  }
}

/** Record a partition database as owned by `accountSub` (idempotent). */
export function registerPartitionDatabase(accountSub: string, databaseName: string): void {
  const registry = readRegistry();
  if (registry[databaseName] === accountSub) return;
  registry[databaseName] = accountSub;
  writeRegistry(registry);
}

/** Delete every partition database registered to `accountSub`. Returns the count. */
export async function purgeAccountPartitions(accountSub: string): Promise<number> {
  const registry = readRegistry();
  const mine = Object.entries(registry).filter(([, sub]) => sub === accountSub);
  await Promise.all(
    mine.map(
      ([databaseName]) =>
        new Promise<void>((resolve) => {
          const request = globalThis.indexedDB?.deleteDatabase(databaseName);
          if (!request) return resolve();
          request.onsuccess = () => resolve();
          request.onerror = () => resolve();
          // A blocked delete (an open connection elsewhere) resolves too —
          // the delete completes when the connection closes; don't hang sign-out.
          request.onblocked = () => resolve();
        }),
    ),
  );
  for (const [databaseName] of mine) delete registry[databaseName];
  writeRegistry(registry);
  return mine.length;
}
