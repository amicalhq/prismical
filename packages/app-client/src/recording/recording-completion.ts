'use client';

const RECOVERY_PREFIX = 'prismical-recording-completion-v1:';

export type PendingRecordingCompletion = {
  version: 1;
  recordingId: string;
  durationMs: number;
  endedAt: number;
  createdAt: number;
  ownerSub: string;
  ownerOrgId: string;
  /** Exact browser login slot; support and ordinary sessions may share sub + org. */
  ownerSessionKey: string;
  noteId?: string;
};

function browserRecoveryStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function tabRecoveryStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isTabScopedRecovery(item: PendingRecordingCompletion): boolean {
  return item.ownerSessionKey !== item.ownerSub;
}

function isPendingRecordingCompletion(value: unknown): value is PendingRecordingCompletion {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<PendingRecordingCompletion>;
  return (
    row.version === 1 &&
    typeof row.recordingId === 'string' &&
    row.recordingId.length > 0 &&
    typeof row.durationMs === 'number' &&
    Number.isFinite(row.durationMs) &&
    row.durationMs >= 0 &&
    typeof row.endedAt === 'number' &&
    Number.isFinite(row.endedAt) &&
    typeof row.createdAt === 'number' &&
    Number.isFinite(row.createdAt) &&
    typeof row.ownerSub === 'string' &&
    row.ownerSub.length > 0 &&
    typeof row.ownerOrgId === 'string' &&
    row.ownerOrgId.length > 0 &&
    typeof row.ownerSessionKey === 'string' &&
    row.ownerSessionKey.length > 0 &&
    (row.noteId === undefined || typeof row.noteId === 'string')
  );
}

/** Persist a recording completion so reload/reconnect can retry the stop request. */
export function savePendingRecordingCompletion(item: PendingRecordingCompletion): boolean {
  const storage = isTabScopedRecovery(item) ? tabRecoveryStorage() : browserRecoveryStorage();
  if (!storage) return false;
  try {
    const key = `${RECOVERY_PREFIX}${item.recordingId}`;
    const value = JSON.stringify(item);
    storage.setItem(key, value);
    if (storage.getItem(key) !== value) return false;
    const otherStorage = isTabScopedRecovery(item)
      ? browserRecoveryStorage()
      : tabRecoveryStorage();
    otherStorage?.removeItem(key);
    return true;
  } catch {
    // The caller retains an in-memory retry when browser storage is unavailable.
    return false;
  }
}

export function listPendingRecordingCompletions(): PendingRecordingCompletion[] {
  const items = new Map<string, PendingRecordingCompletion>();
  const read = (storage: Storage | null) => {
    if (!storage) return;
    try {
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(RECOVERY_PREFIX)) continue;
        const raw = storage.getItem(key);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (isPendingRecordingCompletion(parsed)) items.set(parsed.recordingId, parsed);
        } catch {
          // One damaged entry must not hide other recordings awaiting recovery.
        }
      }
    } catch {
      // Return every row parsed before storage became unavailable.
    }
  };
  read(browserRecoveryStorage());
  read(tabRecoveryStorage());

  return [...items.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function removePendingRecordingCompletion(recordingId: string): void {
  try {
    browserRecoveryStorage()?.removeItem(`${RECOVERY_PREFIX}${recordingId}`);
    tabRecoveryStorage()?.removeItem(`${RECOVERY_PREFIX}${recordingId}`);
  } catch {
    // A completed retry must not become a UI error because localStorage cleanup was denied.
  }
}
