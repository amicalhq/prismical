// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listPendingStagingRecoveries,
  savePendingStagingRecovery,
  startStagingBuffer,
} from './staging-buffer';

class BrokenMediaRecorder {
  static last: BrokenMediaRecorder | null = null;
  static isTypeSupported() {
    return true;
  }
  state: RecordingState = 'inactive';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;
  constructor() {
    BrokenMediaRecorder.last = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
  pause() {}
  resume() {}
}

describe('staging buffer durability', () => {
  const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalStorage) {
      Object.defineProperty(navigator, 'storage', originalStorage);
    } else {
      delete (navigator as { storage?: unknown }).storage;
    }
  });

  it('keeps exact non-ordinary session ownership tab-scoped', () => {
    localStorage.clear();
    sessionStorage.clear();

    expect(
      savePendingStagingRecovery({
        version: 2,
        recordingId: 'rec_private',
        contentType: 'audio/webm',
        durationMs: 10_000,
        endedAt: Date.now(),
        createdAt: Date.now(),
        ownerSub: 'user_1',
        ownerOrgId: 'org_1',
        ownerSessionKey: 'support_lifecycle_1',
        transcriptionDeferred: true,
        needsFinalize: false,
        action: 'upload',
      })
    ).toBe(true);

    expect(JSON.stringify(localStorage)).not.toContain('support_lifecycle_1');
    expect(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))).toEqual([]);
    expect(sessionStorage.getItem('prismical-staging-recovery-v2:rec_private')).toContain(
      'support_lifecycle_1'
    );
  });

  it('durably migrates an ordinary V1 recovery before removing its legacy row', () => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem(
      'prismical-staging-recovery-v1:rec_legacy',
      JSON.stringify({
        version: 1,
        recordingId: 'rec_legacy',
        contentType: 'audio/webm',
        durationMs: 10_000,
        endedAt: 20,
        createdAt: 10,
        ownerSub: 'user_1',
        ownerOrgId: 'org_1',
        transcriptionDeferred: true,
        needsFinalize: false,
        action: 'upload',
      })
    );

    expect(listPendingStagingRecoveries()).toEqual([
      expect.objectContaining({
        version: 2,
        recordingId: 'rec_legacy',
        ownerSessionKey: 'user_1',
      }),
    ]);
    expect(localStorage.getItem('prismical-staging-recovery-v1:rec_legacy')).toBeNull();
    expect(localStorage.getItem('prismical-staging-recovery-v2:rec_legacy')).toContain(
      '"ownerSessionKey":"user_1"'
    );
  });

  it.each(['pause', 'resume'] as const)(
    'rejects the buffer when recorder %s fails',
    async action => {
      vi.stubGlobal('MediaRecorder', BrokenMediaRecorder);
      const buffer = await startStagingBuffer({} as MediaStream, 'rec_transition');
      const recorder = BrokenMediaRecorder.last!;
      recorder.ondataavailable?.({ data: new Blob(['audio']) } as BlobEvent);
      recorder.state = action === 'pause' ? 'recording' : 'paused';
      recorder[action] = () => {
        throw new Error('recorder transition failed');
      };
      buffer![action]();
      await expect(buffer!.stop()).resolves.toBeNull();
    }
  );

  it('closes and deletes a broken OPFS writer instead of exposing partial audio to recovery', async () => {
    const write = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const removeEntry = vi.fn(async () => {});
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        getDirectory: vi.fn(async () => ({
          getFileHandle: vi.fn(async () => ({
            createWritable: vi.fn(async () => ({ write, close })),
            getFile: vi.fn(async () => new File(['partial'], 'staging-rec_broken')),
          })),
          removeEntry,
        })),
      },
    });
    vi.stubGlobal('MediaRecorder', BrokenMediaRecorder);

    const buffer = await startStagingBuffer({} as MediaStream, 'rec_broken');
    expect(buffer?.durable).toBe(true);

    BrokenMediaRecorder.last?.ondataavailable?.({
      data: new Blob(['partial']),
    } as BlobEvent);
    BrokenMediaRecorder.last?.onerror?.();

    await expect(buffer?.stop()).resolves.toBeNull();
    expect(write).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(removeEntry).toHaveBeenCalledWith('staging-rec_broken');
  });
});
