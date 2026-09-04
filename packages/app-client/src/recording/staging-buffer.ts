"use client";

/**
 * Always-on local session buffer for the web capture path — the web
 * equivalent of desktop's recovery WAVs. A parallel MediaRecorder encodes the SAME MediaStream
 * the AudioWorklet transcribes (Opus ~32kbps ≈ 14MB/hr), buffering into OPFS when available
 * (survives a mid-meeting tab crash and deferred upload retries) with an in-memory fallback
 * (incognito, denied quota).
 * At stop, the blob uploads to a staging signed URL; buffering failure or unavailability just
 * means the recording skips the finalize pass — degradation, never an error the user sees.
 */

const OPFS_PREFIX = "staging-";
const RECOVERY_V1_PREFIX = "prismical-staging-recovery-v1:";
const RECOVERY_V2_PREFIX = "prismical-staging-recovery-v2:";

export type PendingStagingRecovery = {
  version: 2;
  recordingId: string;
  contentType: string;
  durationMs: number;
  endedAt: number;
  createdAt: number;
  ownerSub: string;
  ownerOrgId: string;
  /** Exact browser login slot; support and ordinary sessions may share sub + org. */
  ownerSessionKey: string;
  transcriptionDeferred: boolean;
  needsFinalize: boolean;
  action: "upload" | "abandon";
  abandonReason?: "no-audio" | "staging-disabled" | "upload-failed";
};

type PendingStagingRecoveryV1 = Omit<
  PendingStagingRecovery,
  "version" | "ownerSessionKey"
> & { version: 1 };

function browserRecoveryStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function tabRecoveryStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isTabScopedRecovery(item: PendingStagingRecovery): boolean {
  return item.ownerSessionKey !== item.ownerSub;
}

function isPendingStagingRecovery(value: unknown): value is PendingStagingRecovery {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<PendingStagingRecovery>;
  return (
    row.version === 2 &&
    typeof row.recordingId === "string" &&
    row.recordingId.length > 0 &&
    typeof row.contentType === "string" &&
    (row.contentType === "audio/webm" || row.contentType === "audio/mp4") &&
    typeof row.durationMs === "number" &&
    Number.isFinite(row.durationMs) &&
    row.durationMs >= 0 &&
    typeof row.endedAt === "number" &&
    Number.isFinite(row.endedAt) &&
    typeof row.createdAt === "number" &&
    Number.isFinite(row.createdAt) &&
    typeof row.ownerSub === "string" &&
    row.ownerSub.length > 0 &&
    typeof row.ownerOrgId === "string" &&
    row.ownerOrgId.length > 0 &&
    typeof row.ownerSessionKey === "string" &&
    row.ownerSessionKey.length > 0 &&
    typeof row.transcriptionDeferred === "boolean" &&
    typeof row.needsFinalize === "boolean" &&
    (row.action === "upload" ||
      (row.action === "abandon" &&
        (row.abandonReason === "no-audio" ||
          row.abandonReason === "staging-disabled" ||
          row.abandonReason === "upload-failed")))
  );
}

function isPendingStagingRecoveryV1(value: unknown): value is PendingStagingRecoveryV1 {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<PendingStagingRecoveryV1>;
  return (
    row.version === 1 &&
    typeof row.recordingId === "string" &&
    row.recordingId.length > 0 &&
    typeof row.contentType === "string" &&
    (row.contentType === "audio/webm" || row.contentType === "audio/mp4") &&
    typeof row.durationMs === "number" &&
    Number.isFinite(row.durationMs) &&
    row.durationMs >= 0 &&
    typeof row.endedAt === "number" &&
    Number.isFinite(row.endedAt) &&
    typeof row.createdAt === "number" &&
    Number.isFinite(row.createdAt) &&
    typeof row.ownerSub === "string" &&
    row.ownerSub.length > 0 &&
    typeof row.ownerOrgId === "string" &&
    row.ownerOrgId.length > 0 &&
    typeof row.transcriptionDeferred === "boolean" &&
    typeof row.needsFinalize === "boolean" &&
    (row.action === "upload" ||
      (row.action === "abandon" &&
        (row.abandonReason === "no-audio" ||
          row.abandonReason === "staging-disabled" ||
          row.abandonReason === "upload-failed")))
  );
}

/** Persist the work item before a deferred upload begins so reload/reconnect can resume it. */
export function savePendingStagingRecovery(item: PendingStagingRecovery): boolean {
  const storage = isTabScopedRecovery(item)
    ? tabRecoveryStorage()
    : browserRecoveryStorage();
  if (!storage) return false;
  try {
    const key = `${RECOVERY_V2_PREFIX}${item.recordingId}`;
    const value = JSON.stringify(item);
    storage.setItem(key, value);
    if (storage.getItem(key) !== value) return false;
    const otherStorage = isTabScopedRecovery(item)
      ? browserRecoveryStorage()
      : tabRecoveryStorage();
    otherStorage?.removeItem(key);
    return true;
  } catch {
    // Caller observes false and keeps the server lifecycle bounded.
    return false;
  }
}

/** Probe the second half of deferred durability before disabling the live lane. */
export function canPersistStagingRecovery(tabScoped = false): boolean {
  const storage = tabScoped ? tabRecoveryStorage() : browserRecoveryStorage();
  if (!storage) return false;
  const key = `${RECOVERY_V2_PREFIX}__probe__`;
  try {
    storage.setItem(key, "1");
    const persisted = storage.getItem(key) === "1";
    storage.removeItem(key);
    return persisted;
  } catch {
    return false;
  }
}

export function listPendingStagingRecoveries(): PendingStagingRecovery[] {
  const items = new Map<string, PendingStagingRecovery>();
  const readV2 = (storage: Storage | null) => {
    if (!storage) return;
    try {
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(RECOVERY_V2_PREFIX)) continue;
        const raw = storage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as unknown;
        if (isPendingStagingRecovery(parsed)) items.set(parsed.recordingId, parsed);
      }
    } catch {
      // Return every row parsed before storage became unavailable.
    }
  };
  readV2(browserRecoveryStorage());
  readV2(tabRecoveryStorage());

  // V1 predates exact support sessions, so every V1 row is an ordinary session
  // whose exact slot is its subject. Rewrite durably before removing the old row.
  const browserStorage = browserRecoveryStorage();
  if (browserStorage) {
    try {
      const v1Rows: Array<{ key: string; row: PendingStagingRecoveryV1 }> = [];
      for (let index = 0; index < browserStorage.length; index++) {
        const key = browserStorage.key(index);
        if (!key?.startsWith(RECOVERY_V1_PREFIX)) continue;
        const raw = browserStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as unknown;
        if (isPendingStagingRecoveryV1(parsed)) v1Rows.push({ key, row: parsed });
      }
      for (const { key, row } of v1Rows) {
        const migrated: PendingStagingRecovery = {
          ...row,
          version: 2,
          ownerSessionKey: row.ownerSub,
        };
        items.set(migrated.recordingId, migrated);
        if (savePendingStagingRecovery(migrated)) browserStorage.removeItem(key);
      }
    } catch {
      // Preserve the original V1 row when parsing or durable rewrite fails.
    }
  }
  return [...items.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function removePendingStagingRecovery(recordingId: string): void {
  try {
    browserRecoveryStorage()?.removeItem(`${RECOVERY_V1_PREFIX}${recordingId}`);
    browserRecoveryStorage()?.removeItem(`${RECOVERY_V2_PREFIX}${recordingId}`);
    tabRecoveryStorage()?.removeItem(`${RECOVERY_V2_PREFIX}${recordingId}`);
  } catch {
    // A completed retry must not become a UI error because localStorage cleanup was denied.
  }
}

/** MediaRecorder container per browser: Chrome/Edge/Firefox → webm/opus; Safari → mp4/aac. */
function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}

/** The staging content type for a MediaRecorder mimeType. */
function contentTypeOf(mimeType: string): string {
  return mimeType.startsWith("audio/mp4") ? "audio/mp4" : "audio/webm";
}

async function opfsDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await navigator.storage.getDirectory();
  } catch {
    return null; // incognito / unsupported / denied
  }
}

/** Only entries this stale are swept — protects a concurrent tab's ACTIVE buffer (its target
 * file looks old/empty while the writable's swap holds the data, so age is the only safe test). */
const SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Best-effort removal of buffers from sessions that never reached discard (tab crash). */
export async function sweepStagingBuffers(keepRecordingId?: string): Promise<void> {
  const dir = await opfsDir();
  if (!dir) return;
  try {
    const keep = keepRecordingId ? `${OPFS_PREFIX}${keepRecordingId}` : null;
    const recoveryFiles = new Set(
      listPendingStagingRecoveries().map(item => `${OPFS_PREFIX}${item.recordingId}`)
    );
    // entries() is an async iterator; removals are safe during iteration per the OPFS spec.
    for await (const [name, handle] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (
        !name.startsWith(OPFS_PREFIX) ||
        name === keep ||
        recoveryFiles.has(name) ||
        handle.kind !== "file"
      )
        continue;
      const file = await (handle as FileSystemFileHandle).getFile().catch(() => null);
      if (file && Date.now() - file.lastModified < SWEEP_MIN_AGE_MS) continue;
      await dir.removeEntry(name).catch(() => {});
    }
  } catch {
    // sweep is hygiene, never load-bearing
  }
}

/** Reopen a finalized OPFS artifact on launch/reconnect. Memory-only buffers cannot cross reload. */
export async function readStagingBuffer(
  recordingId: string,
  contentType: string
): Promise<Blob | null> {
  const dir = await opfsDir();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(`${OPFS_PREFIX}${recordingId}`);
    const file = await handle.getFile();
    return file.size > 0 ? new Blob([file], { type: contentType }) : null;
  } catch {
    return null;
  }
}

export async function discardStagingBuffer(recordingId: string): Promise<void> {
  const dir = await opfsDir();
  await dir?.removeEntry(`${OPFS_PREFIX}${recordingId}`).catch(() => {});
}

export interface StagingBuffer {
  /** Content type for the mint/complete round-trip (audio/webm | audio/mp4). */
  contentType: string;
  /** True only when the full session is being written to crash-persistent OPFS. */
  durable: boolean;
  pause(): void;
  resume(): void;
  /** Stop the recorder and assemble the full-session blob; null when buffering broke. */
  stop(): Promise<Blob | null>;
  /** Remove the OPFS artifact (after upload success, or when abandoning the session). */
  discard(): Promise<void>;
}

/**
 * Start buffering `stream`. Returns null when the environment can't buffer at all (no
 * MediaRecorder / no supported container) — callers proceed without staging.
 */
export async function startStagingBuffer(
  stream: MediaStream,
  recordingId: string
): Promise<StagingBuffer | null> {
  const mimeType = pickMimeType();
  if (!mimeType) return null;

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 });
  } catch {
    return null;
  }

  const fileName = `${OPFS_PREFIX}${recordingId}`;
  const memoryParts: Blob[] = [];
  // OPFS writer state: a serialized write chain; null until ready, false after a failure
  // (fall back to memory from that point — parts already written are re-read at stop).
  let writable: FileSystemWritableFileStream | null | false = null;
  let writeChain = Promise.resolve();
  let broken = false;

  const ready = (async () => {
    const dir = await opfsDir();
    if (!dir) {
      writable = false;
      return;
    }
    try {
      const handle = await dir.getFileHandle(fileName, { create: true });
      writable = await handle.createWritable({ keepExistingData: false });
    } catch {
      writable = false; // e.g. Safari main-thread createWritable — memory fallback
    }
  })();

  recorder.ondataavailable = (ev: BlobEvent) => {
    if (ev.data.size === 0) return;
    writeChain = writeChain.then(async () => {
      await ready;
      if (writable === false) {
        memoryParts.push(ev.data);
        return;
      }
      try {
        await (writable as FileSystemWritableFileStream).write(ev.data);
      } catch {
        // Quota mid-session etc. — the buffer is now incomplete either way; mark broken so
        // stop() reports null rather than uploading a truncated session.
        broken = true;
      }
    });
  };
  recorder.onerror = () => {
    broken = true;
  };
  await ready;
  // `ready` always settles this to a writer or false; TypeScript cannot observe assignment from
  // the async initializer closure, so capture that postcondition explicitly.
  const startedWritable = writable as unknown as FileSystemWritableFileStream | false;
  try {
    recorder.start(1000);
  } catch {
    if (startedWritable !== false) await startedWritable.close().catch(() => {});
    await discardStagingBuffer(recordingId);
    return null;
  }

  const stopRecorder = () =>
    new Promise<void>((resolve) => {
      if (recorder.state === "inactive") return resolve();
      recorder.onstop = () => resolve();
      try {
        recorder.stop();
      } catch {
        resolve();
      }
    });

  return {
    contentType: contentTypeOf(mimeType),
    durable: startedWritable !== false,
    pause() {
      // Mirrors the live lane's convention: paused wall-time is compressed out of the timeline.
      try {
        if (recorder.state === "recording") recorder.pause();
      } catch {
        /* a recorder that can't pause keeps recording — the overlap is harmless */
      }
    },
    resume() {
      try {
        if (recorder.state === "paused") recorder.resume();
      } catch {
        /* resume failure surfaces as a truncated buffer at stop, handled there */
      }
    },
    async stop() {
      await stopRecorder();
      await writeChain;
      if (broken) {
        const current = writable as FileSystemWritableFileStream | null | false;
        if (current !== false && current !== null) await current.close().catch(() => {});
        await discardStagingBuffer(recordingId);
        return null;
      }
      if (writable === false) {
        return memoryParts.length ? new Blob(memoryParts, { type: mimeType }) : null;
      }
      try {
        await (writable as FileSystemWritableFileStream).close();
        const dir = await opfsDir();
        const handle = await dir?.getFileHandle(fileName);
        const file = (await handle?.getFile()) ?? null;
        return file && file.size > 0 ? file : null;
      } catch {
        return null;
      }
    },
    async discard() {
      await discardStagingBuffer(recordingId);
    },
  };
}
