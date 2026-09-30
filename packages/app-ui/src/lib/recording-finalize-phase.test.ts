import { describe, expect, it } from 'vitest';
import type { CoreRecording } from '@prismical/app-client';
import { recordingFinalizePhase, recordingIsProcessing } from './recording-finalize-phase';

const now = Date.parse('2026-08-01T12:00:00Z');
const recording: CoreRecording = {
  id: 'recording',
  noteId: 'note',
  title: '',
  status: 'completed',
  startedAt: new Date(now - 60 * 60_000).toISOString(),
  endedAt: new Date(now - 1000).toISOString(),
  durationMs: 60 * 60_000,
};

describe('recording processing phase', () => {
  it('does not poll transcript data while the file is still uploading', () => {
    const phase = recordingFinalizePhase(
      { ...recording, meta: { import: { phase: 'uploading' } } },
      now
    );
    expect(phase).toBe('uploading');
    expect(recordingIsProcessing(phase)).toBe(false);
  });
  it('bounds stalled import processing using the latest status timestamp', () => {
    expect(
      recordingFinalizePhase(
        {
          ...recording,
          updatedAt: new Date(now - 31 * 60_000).toISOString(),
          meta: { import: { phase: 'transcribing' } },
        },
        now
      )
    ).toBe('stalled');
    expect(
      recordingFinalizePhase(
        {
          ...recording,
          updatedAt: new Date(now - 1000).toISOString(),
          meta: { import: { phase: 'checking' } },
        },
        now
      )
    ).toBe('pending');
  });
  it('keeps a newly stopped hour-long recording waiting for server stitching', () => {
    const phase = recordingFinalizePhase(
      { ...recording, meta: { finalize: { status: 'pending' } } },
      now
    );
    expect(phase).toBe('pending');
    expect(recordingIsProcessing(phase)).toBe(true);
  });

  it('uses the staged timestamp after server stitching', () => {
    expect(
      recordingFinalizePhase(
        {
          ...recording,
          endedAt: recording.startedAt,
          meta: {
            staging: { stagedAt: new Date(now - 1000).toISOString() },
            finalize: { status: 'running' },
          },
        },
        now
      )
    ).toBe('running');
  });

  it('bounds a stalled server pass without replacing settled outcomes', () => {
    expect(
      recordingFinalizePhase(
        {
          ...recording,
          endedAt: recording.startedAt,
          meta: { finalize: { status: 'pending' } },
        },
        now
      )
    ).toBe('stalled');
    expect(
      recordingFinalizePhase(
        { ...recording, endedAt: recording.startedAt, meta: { finalize: { status: 'done' } } },
        now
      )
    ).toBe('done');
  });
});
