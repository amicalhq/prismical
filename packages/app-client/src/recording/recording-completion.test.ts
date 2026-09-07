// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listPendingRecordingCompletions,
  removePendingRecordingCompletion,
  savePendingRecordingCompletion,
  type PendingRecordingCompletion,
} from './recording-completion';

const completion: PendingRecordingCompletion = {
  version: 1,
  recordingId: 'rec_test',
  noteId: 'note_test',
  durationMs: 1000,
  endedAt: 1000,
  createdAt: 1000,
  ownerSub: 'user_test',
  ownerOrgId: 'org_test',
  ownerSessionKey: 'user_test',
};
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('recording completion recovery', () => {
  it('persists the owner and stop metadata until completion succeeds', () => {
    expect(savePendingRecordingCompletion(completion)).toBe(true);
    expect(listPendingRecordingCompletions()).toEqual([completion]);
    expect(localStorage.length).toBe(1);
    expect(sessionStorage.length).toBe(0);
    removePendingRecordingCompletion(completion.recordingId);
    expect(listPendingRecordingCompletions()).toEqual([]);
  });

  it('keeps a support session completion within its browser tab', () => {
    const support = { ...completion, ownerSessionKey: 'support_test' };
    expect(savePendingRecordingCompletion(support)).toBe(true);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(1);
    expect(listPendingRecordingCompletions()).toEqual([support]);
  });

  it('reports storage refusal so the caller can retain an in-memory retry', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    expect(savePendingRecordingCompletion(completion)).toBe(false);
    expect(listPendingRecordingCompletions()).toEqual([]);
  });
});
