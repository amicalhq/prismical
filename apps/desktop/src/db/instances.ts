import { eq, and } from "drizzle-orm";
import { db } from ".";
import {
  instances,
  type Instance,
  type NewInstance,
  type InstanceConfig,
  type LocalWhisperConfig,
  type LocalWhisperDownloadedModel,
} from "./schema";
import { PROVIDER_TYPES } from "../constants/provider-types";

/**
 * Database operations for the `instances` table (provider connections).
 *
 * Layered separation:
 *   - This file: pure CRUD + type-narrowed config mutations.
 *   - Validation that `config` matches `type`: tRPC router (Zod schemas).
 *   - Singleton enforcement: bootstrap uses `seedInstanceIfMissing`; the
 *     tRPC router rejects user attempts to add singletons.
 */

export async function getAllInstances(): Promise<Instance[]> {
  return await db.select().from(instances);
}

export async function getInstancesByType(type: string): Promise<Instance[]> {
  return await db.select().from(instances).where(eq(instances.type, type));
}

export async function getInstanceById(id: string): Promise<Instance | null> {
  const rows = await db
    .select()
    .from(instances)
    .where(eq(instances.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function createInstance(row: NewInstance): Promise<Instance> {
  const inserted = await db.insert(instances).values(row).returning();
  return inserted[0];
}

/**
 * Idempotent seed for singleton system instances. The fixed primary key
 * provides at-most-one semantics; this helper is the standard way to
 * ensure a singleton row exists without throwing on subsequent runs.
 */
export async function seedInstanceIfMissing(row: NewInstance): Promise<void> {
  await db.insert(instances).values(row).onConflictDoNothing({
    target: instances.id,
  });
}

export type InstancePatch = {
  label?: string;
  config?: InstanceConfig;
};

/**
 * Update label and/or config. The `type` column is intentionally not
 * patchable — switching an instance's type would invalidate its config
 * shape and any defaults pointing at its models.
 *
 * Note: this helper does NOT validate that `patch.config` matches the
 * existing row's type. Per-type config validation belongs to the tRPC
 * router (Zod schemas keyed on type). Callers that bypass tRPC must
 * validate themselves.
 */
export async function updateInstance(
  id: string,
  patch: InstancePatch,
): Promise<Instance | null> {
  if (patch.label === undefined && patch.config === undefined) {
    return await getInstanceById(id);
  }

  // Build the SET clause explicitly so an explicit `undefined` in `patch`
  // can never overwrite an existing column with NULL.
  const set: { label?: string; config?: InstanceConfig; updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.config !== undefined) set.config = patch.config;

  const updated = await db
    .update(instances)
    .set(set)
    .where(eq(instances.id, id))
    .returning();

  return updated[0] ?? null;
}

export async function deleteInstance(id: string): Promise<boolean> {
  const result = await db
    .delete(instances)
    .where(eq(instances.id, id))
    .returning({ id: instances.id });
  return result.length > 0;
}

// ---------- Errors ----------
// Exported so callers can `instanceof`-check rather than parse messages.

export class InstanceNotFoundError extends Error {
  constructor(id: string) {
    super(`Instance ${id} not found`);
    this.name = "InstanceNotFoundError";
  }
}

export class InstanceTypeMismatchError extends Error {
  constructor(id: string, expected: string, actual: string) {
    super(
      `Instance ${id} has type "${actual}" but expected "${expected}"`,
    );
    this.name = "InstanceTypeMismatchError";
  }
}

// ---------- Type-narrowing fetch ----------

/**
 * Fetch a row by id while asserting its type. Returns the row on match,
 * `null` if no row exists with that id, and *throws* `InstanceTypeMismatchError`
 * if the row exists but has a different type. This pattern avoids
 * duplicating the disambiguation dance in every caller that needs to
 * narrow `instance.config` to a specific shape.
 */
export async function getInstanceByIdAndType(
  id: string,
  type: string,
): Promise<Instance | null> {
  const row = await getInstanceById(id);
  if (!row) return null;
  if (row.type !== type) {
    throw new InstanceTypeMismatchError(id, type, row.type);
  }
  return row;
}

// ---------- Local-whisper config mutations ----------
// Read-modify-write helpers wrapped in a transaction so the download
// manager can append/remove entries atomically. They throw if the
// instance is missing or not a local-whisper row.
//
// Crash window: callers fs.write the .bin file *then* call these helpers.
// If the app crashes between the two, the file exists on disk but isn't
// tracked. Bootstrap reconciles by scanning the directory at startup —
// see task 7 / `reconcileLocalWhisperDownloads`.

// Capture the transaction handle's type from drizzle's own callback signature
// so this helper rejects accidentally being passed something that merely
// happens to expose `.select`.
type DbOrTx =
  | typeof db
  | Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

async function loadLocalWhisperRow(
  tx: DbOrTx,
  instanceId: string,
): Promise<Instance> {
  const rows = await tx
    .select()
    .from(instances)
    .where(
      and(
        eq(instances.id, instanceId),
        eq(instances.type, PROVIDER_TYPES.localWhisper),
      ),
    )
    .limit(1);

  if (rows[0]) return rows[0];

  // Disambiguate: missing entirely vs. wrong type.
  const probe = await tx
    .select({ type: instances.type })
    .from(instances)
    .where(eq(instances.id, instanceId))
    .limit(1);
  if (probe.length === 0) throw new InstanceNotFoundError(instanceId);
  throw new InstanceTypeMismatchError(
    instanceId,
    PROVIDER_TYPES.localWhisper,
    probe[0].type,
  );
}

/**
 * Append a downloaded whisper model to the local-whisper instance's config.
 * If an entry with the same `id` already exists it's replaced (newer
 * download wins — picks up updated checksum / sizeBytes).
 */
export async function addLocalWhisperModel(
  instanceId: string,
  entry: LocalWhisperDownloadedModel,
): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await loadLocalWhisperRow(tx, instanceId);
    const config = row.config as LocalWhisperConfig;
    const existing = config.downloadedModels ?? [];
    const next: LocalWhisperConfig = {
      downloadedModels: [
        ...existing.filter((m) => m.id !== entry.id),
        entry,
      ],
    };

    await tx
      .update(instances)
      .set({ config: next, updatedAt: new Date() })
      .where(eq(instances.id, instanceId));
  });
}

/**
 * Remove a downloaded whisper model entry. No-op if the entry isn't
 * present — the file may already have been deleted by another path.
 */
export async function removeLocalWhisperModel(
  instanceId: string,
  modelId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await loadLocalWhisperRow(tx, instanceId);
    const config = row.config as LocalWhisperConfig;
    const existing = config.downloadedModels ?? [];
    const next: LocalWhisperConfig = {
      downloadedModels: existing.filter((m) => m.id !== modelId),
    };

    if (next.downloadedModels.length === existing.length) return; // no-op

    await tx
      .update(instances)
      .set({ config: next, updatedAt: new Date() })
      .where(eq(instances.id, instanceId));
  });
}

// Re-export types for callers
export type { Instance, NewInstance } from "./schema";
