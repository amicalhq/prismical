import { describe, expect, it, beforeEach } from 'vitest';
import { useAutoEnhanceStore } from './auto-enhance-store';

describe('useAutoEnhanceStore', () => {
  beforeEach(() => {
    useAutoEnhanceStore.setState({ requests: [], failedRecordingId: null });
  });

  it('publishes a failed recording so its Enhance chip can be offered again', () => {
    useAutoEnhanceStore.getState().markFailed('rec_1');
    expect(useAutoEnhanceStore.getState().failedRecordingId).toBe('rec_1');
  });

  it('clears a previous failure when a fresh run is requested', () => {
    // Otherwise the transcript bar would keep holding open for a recording already retried.
    useAutoEnhanceStore.getState().markFailed('rec_1');
    useAutoEnhanceStore.getState().requestAutoEnhance({
      noteId: 'nt_1',
      recordingId: 'rec_1',
      source: 'auto-enhance',
      ownerSessionKey: 'session_1',
      ownerOrgId: 'org_1',
    });
    expect(useAutoEnhanceStore.getState().failedRecordingId).toBeNull();
    expect(useAutoEnhanceStore.getState().requests).toEqual([
      {
        noteId: 'nt_1',
        recordingId: 'rec_1',
        source: 'auto-enhance',
        ownerSessionKey: 'session_1',
        ownerOrgId: 'org_1',
      },
    ]);
  });

  it('drops the marker when the same recording is retried', () => {
    useAutoEnhanceStore.getState().markFailed('rec_1');
    useAutoEnhanceStore.getState().clearFailed('rec_1');
    expect(useAutoEnhanceStore.getState().failedRecordingId).toBeNull();
  });

  it("leaves another recording's failure alone", () => {
    useAutoEnhanceStore.getState().markFailed('rec_1');
    useAutoEnhanceStore.getState().clearFailed('rec_2');
    expect(useAutoEnhanceStore.getState().failedRecordingId).toBe('rec_1');
  });

  it('keeps the failure when the dock consumes the request', () => {
    // `clear()` fires as soon as the dock kicks the run off — long before it can fail, so it must
    // not wipe a failure recorded by the run that follows.
    useAutoEnhanceStore.getState().markFailed('rec_1');
    useAutoEnhanceStore.getState().clear();
    expect(useAutoEnhanceStore.getState().failedRecordingId).toBe('rec_1');
  });
});
