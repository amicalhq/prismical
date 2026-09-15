// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  advanceWalkthrough,
  readWalkthrough,
  walkthroughKey,
  writeWalkthrough,
  type Walkthrough,
} from './state';
const memory = vi.hoisted(() => ({ userId: 'a', state: null as unknown, ready: true }));
vi.mock('@prismical/app-client', () => ({
  currentAccountExperience: () => ({
    userId: memory.userId,
    getSnapshot: () => ({
      data: memory.ready ? { onboarding: { walkthrough: memory.state } } : null,
    }),
    update: (patch: { onboarding: { walkthrough: unknown } }) => {
      if (!memory.ready) return false;
      memory.state = patch.onboarding.walkthrough;
      return true;
    },
  }),
}));
const initial: Walkthrough = { status: 'active', orgId: 'org-a', noteId: 'note-a', step: 'record' };
beforeEach(() => {
  memory.userId = 'a';
  memory.state = null;
  memory.ready = true;
  window.localStorage.clear();
  vi.restoreAllMocks();
});
describe('first-note walkthrough persistence and progression', () => {
  it('rejects reads and writes belonging to a previous account', () => {
    expect(writeWalkthrough(walkthroughKey('a'), { status: 'completed' })).toBe(true);
    expect(readWalkthrough(walkthroughKey('a'))).toEqual({ status: 'completed' });
    memory.userId = 'b';
    memory.state = null;
    expect(writeWalkthrough(walkthroughKey('a'), { status: 'dismissed' })).toBe(false);
    expect(readWalkthrough(walkthroughKey('a'))).toBeNull();
    expect(readWalkthrough(walkthroughKey('b'))).toBeNull();
  });
  it('waits for the account and never falls back to legacy browser state', () => {
    memory.ready = false;
    window.localStorage.setItem(walkthroughKey('a'), JSON.stringify({ status: 'completed' }));
    expect(readWalkthrough(walkthroughKey('a'))).toBeNull();
    expect(writeWalkthrough(walkthroughKey('a'), initial)).toBe(false);
  });
  it('only completes after matching recording, finalization, review and Apply', () => {
    expect(advanceWalkthrough(initial, { type: 'kept', noteId: 'note-a', recordingId: 'r' })).toBe(
      initial
    );
    const recording = advanceWalkthrough(initial, {
      type: 'recording',
      noteId: 'note-a',
      recordingId: 'r',
    });
    expect(
      advanceWalkthrough(recording, { type: 'recording', noteId: 'note-a', recordingId: 'r' })
    ).toBe(recording);
    expect(
      advanceWalkthrough(recording, { type: 'recorded', noteId: 'note-b', recordingId: 'r' })
    ).toBe(recording);
    expect(
      advanceWalkthrough(recording, { type: 'recorded', noteId: 'note-a', recordingId: 'old' })
    ).toBe(recording);
    const enhanced = advanceWalkthrough(recording, {
      type: 'recorded',
      noteId: 'note-a',
      recordingId: 'r',
    });
    const review = advanceWalkthrough(enhanced, {
      type: 'review',
      noteId: 'note-a',
      recordingId: 'r',
    });
    expect(advanceWalkthrough(review, { type: 'review', noteId: 'note-a', recordingId: 'r' })).toBe(
      review
    );
    const done = advanceWalkthrough(review, { type: 'kept', noteId: 'note-a', recordingId: 'r' });
    expect(done).toEqual({ status: 'completed' });
    expect(advanceWalkthrough(done, { type: 'kept', noteId: 'note-a', recordingId: 'r' })).toBe(
      done
    );
  });
  it('retains a resumable note and allows a new recording after interruption', () => {
    const stopped: Walkthrough = { ...initial, step: 'speak', recordingId: 'old' };
    writeWalkthrough(walkthroughKey('a'), stopped);
    expect(
      advanceWalkthrough(readWalkthrough(walkthroughKey('a')), {
        type: 'recording',
        noteId: 'note-a',
        recordingId: 'new',
      })
    ).toEqual({ ...stopped, recordingId: 'new' });
  });
});
