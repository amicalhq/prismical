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
  const removed = await Promise.all(
    mine.map(
      ([databaseName]) =>
        new Promise<boolean>((resolve) => {
          const request = globalThis.indexedDB?.deleteDatabase(databaseName);
          if (!request) return resolve(false);
          request.onsuccess = () => resolve(true);
          request.onerror = () => resolve(false);
          // A legacy tab may retain a connection. Keep its registry entry so a
          // later sign-out can retry; do not claim that a blocked deletion finished.
          request.onblocked = () => resolve(false);
        }),
    ),
  );
  mine.forEach(([databaseName], index) => {
    if (removed[index]) delete registry[databaseName];
  });
  writeRegistry(registry);
  return removed.filter(Boolean).length;
}
