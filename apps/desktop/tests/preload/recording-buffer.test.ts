import { describe, expect, it } from 'vitest';
import type { RecordingStateView } from '@prismical/desktop-contracts';
import { makeRecordingBuffer, type RecordingBufferIpc } from '../../src/preload/recording-buffer';

const idle: RecordingStateView = {
  recordingId: null,
  status: 'idle',
  captureMode: null,
  requestedCaptureMode: null,
  micSource: 'system-default',
  noteId: null,
  segments: [],
  elapsedMs: 0,
};
const recording: RecordingStateView = {
  recordingId: 'rec_1',
  status: 'recording',
  captureMode: 'mic',
  requestedCaptureMode: 'dual',
  micSource: 'system-default',
  noteId: 'note_1',
  segments: [
    {
      id: 'tsg_0',
      recordingId: 'rec_1',
      source: 'mic',
      speaker: 'you',
      text: 'hello',
      startTimeMs: 0,
      endTimeMs: 5000,
      segmentOrder: 1_000_000,
    },
  ],
  elapsedMs: 5000,
};

const makeIpc = () => {
  let handler: ((state: RecordingStateView) => void) | null = null;
  const ipc: RecordingBufferIpc = {
    on: listener => {
      handler = listener;
    },
  };
  return { ipc, push: (state: RecordingStateView) => handler?.(state) };
};

describe('recording buffer (preload)', () => {
  it('replays push-before-subscribe on the first subscription (a recording already running)', () => {
    const h = makeIpc();
    const buffer = makeRecordingBuffer(h.ipc);
    h.push(recording);
    const received: RecordingStateView[] = [];
    buffer.onStateChanged(state => received.push(state));
    expect(received).toEqual([recording]);
  });

  it('delivers push-after-subscribe live', () => {
    const h = makeIpc();
    const buffer = makeRecordingBuffer(h.ipc);
    const received: RecordingStateView[] = [];
    buffer.onStateChanged(state => received.push(state));
    h.push(recording);
    expect(received).toEqual([recording]);
  });

  it('a late subscriber is seeded with the LATEST state, not the full history', () => {
    const h = makeIpc();
    const buffer = makeRecordingBuffer(h.ipc);
    const first: RecordingStateView[] = [];
    buffer.onStateChanged(state => first.push(state));
    h.push(recording);
    h.push(idle);
    const late: RecordingStateView[] = [];
    buffer.onStateChanged(state => late.push(state));
    expect(late).toEqual([idle]);
  });

  it('a second subscriber NEVER detaches the first', () => {
    const h = makeIpc();
    const buffer = makeRecordingBuffer(h.ipc);
    const first: RecordingStateView[] = [];
    const second: RecordingStateView[] = [];
    buffer.onStateChanged(state => first.push(state));
    h.push(recording);
    buffer.onStateChanged(state => second.push(state));
    h.push(idle);
    expect(first).toEqual([recording, idle]);
    expect(second).toEqual([recording, idle]);
  });

  it('unsubscribe stops delivery for that listener only', () => {
    const h = makeIpc();
    const buffer = makeRecordingBuffer(h.ipc);
    const first: RecordingStateView[] = [];
    const second: RecordingStateView[] = [];
    const offFirst = buffer.onStateChanged(state => first.push(state));
    buffer.onStateChanged(state => second.push(state));
    offFirst();
    h.push(recording);
    expect(first).toEqual([]);
    expect(second).toEqual([recording]);
  });
});
