import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { logger } from "../main/logger";
import { AVAILABLE_MODELS } from "../constants/models";
import {
  PROVIDER_TYPES,
  PROVIDER_TYPE_LABELS,
  SINGLETON_INSTANCE_IDS,
  type ProviderType,
} from "../constants/provider-types";
import {
  getInstanceById,
  seedInstanceIfMissing,
  updateInstance,
} from "../db/instances";
import type {
  LocalWhisperConfig,
  LocalWhisperDownloadedModel,
  MockConfig,
  NewInstance,
} from "../db/schema";

/**
 * Bootstrap step run once at app start, after migrations. Ensures the
 * singleton system instances exist and reconciles the local-whisper
 * config against the actual filesystem.
 *
 * Idempotent — safe to run on every launch.
 */
export async function bootstrapInstances(): Promise<void> {
  const includeMock = process.env.NODE_ENV !== "production";
  await seedSystemInstances({ includeMock });
  await reconcileLocalWhisperDownloads();
}

interface SeedOpts {
  includeMock: boolean;
}

async function seedSystemInstances(opts: SeedOpts): Promise<void> {
  const localWhisperRow: NewInstance = systemRow(PROVIDER_TYPES.localWhisper, {
    downloadedModels: [],
  } satisfies LocalWhisperConfig);
  await seedInstanceIfMissing(localWhisperRow);
  logger.main.info("Seeded system local-whisper instance (if missing)");

  if (opts.includeMock) {
    const mockRow: NewInstance = systemRow(
      PROVIDER_TYPES.mock,
      {} satisfies MockConfig,
    );
    await seedInstanceIfMissing(mockRow);
    logger.main.info("Seeded system mock instance (if missing)");
  }
}

function systemRow<T extends ProviderType>(
  type: T,
  config: NewInstance["config"],
): NewInstance {
  const id = SINGLETON_INSTANCE_IDS[type];
  if (!id) {
    // Belt-and-braces: SINGLETON_INSTANCE_IDS must cover every type we seed.
    // If a future change adds a singleton type without an id, fail loudly.
    throw new Error(
      `Cannot seed system instance for "${type}" — no SINGLETON_INSTANCE_IDS entry`,
    );
  }
  return {
    id,
    type,
    label: PROVIDER_TYPE_LABELS[type],
    config,
  };
}

/**
 * Reconcile the local-whisper instance's config against the on-disk
 * downloads directory in two directions:
 *
 *   1. Drop entries whose .bin file no longer exists (user freed disk
 *      space outside the app, etc.).
 *   2. Add entries for .bin files present on disk that aren't tracked
 *      (recovers from a crash between fs.write and addLocalWhisperModel
 *      — see the contract in db/instances.ts).
 *
 * No-op if nothing changed; bumps `updatedAt` only when there's a real diff.
 */
async function reconcileLocalWhisperDownloads(): Promise<void> {
  const instanceId = SINGLETON_INSTANCE_IDS[PROVIDER_TYPES.localWhisper];
  if (!instanceId) return; // unreachable per seedSystemInstances, but keeps TS honest

  const row = await getInstanceById(instanceId);
  if (!row) return; // shouldn't happen — we just seeded above
  if (row.type !== PROVIDER_TYPES.localWhisper) return;

  const modelsDir = path.join(app.getPath("userData"), "models");
  const filesOnDisk = readDirSafe(modelsDir);

  const config = row.config as LocalWhisperConfig;
  const tracked = config.downloadedModels ?? [];
  const trackedById = new Map(tracked.map((m) => [m.id, m]));

  const next: LocalWhisperDownloadedModel[] = [];

  // Direction 1: keep tracked entries whose file exists; drop the rest.
  let droppedCount = 0;
  for (const entry of tracked) {
    if (filesOnDisk.has(entry.filename)) {
      next.push(entry);
    } else {
      droppedCount++;
      logger.main.info("Dropping local-whisper entry — file missing", {
        modelId: entry.id,
        filename: entry.filename,
      });
    }
  }

  // Direction 2: add entries for known .bin files not yet tracked.
  let addedCount = 0;
  for (const model of AVAILABLE_MODELS) {
    if (!filesOnDisk.has(model.filename)) continue;
    if (trackedById.has(model.id)) continue;
    const stats = statSafe(path.join(modelsDir, model.filename));
    if (!stats) continue;
    next.push({
      id: model.id,
      filename: model.filename,
      sizeBytes: stats.size,
      checksum: undefined, // not verifiable post-hoc; future download will fill it
      downloadedAt: stats.mtime.toISOString(),
    });
    addedCount++;
    logger.main.info("Adopting orphaned local-whisper file", {
      modelId: model.id,
      filename: model.filename,
    });
  }

  if (droppedCount === 0 && addedCount === 0) return;

  await updateInstance(instanceId, {
    config: { downloadedModels: next } satisfies LocalWhisperConfig,
  });
  logger.main.info("Reconciled local-whisper downloads", {
    dropped: droppedCount,
    added: addedCount,
    total: next.length,
  });
}

function readDirSafe(dir: string): Set<string> {
  try {
    if (!fs.existsSync(dir)) return new Set();
    return new Set(fs.readdirSync(dir));
  } catch (error) {
    logger.main.warn("Failed to scan local-whisper models directory", {
      dir,
      error,
    });
    return new Set();
  }
}

function statSafe(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}
