// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  advanceWalkthrough,
  readWalkthrough,
  walkthroughKey,
  writeWalkthrough,
  type Walkthrough,
} from './state';
const initial: Walkthrough = { status: 'active', orgId: 'org-a', noteId: 'note-a', step: 'record' };
beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});
describe('first-note walkthrough persistence and progression', () => {
  it('isolates identities and retains dismissal and completion across reads', () => {
    writeWalkthrough(walkthroughKey('a'), { status: 'dismissed' });
    writeWalkthrough(walkthroughKey('b'), { status: 'completed' });
    expect(readWalkthrough(walkthroughKey('a'))).toEqual({ status: 'dismissed' });
    expect(readWalkthrough(walkthroughKey('b'))).toEqual({ status: 'completed' });
    expect(readWalkthrough(walkthroughKey('c'))).toBeNull();
  });
  it('fails closed for broken or unavailable storage', () => {
    window.localStorage.setItem('broken', '{');
    expect(readWalkthrough('broken')).toEqual({ status: 'dismissed' });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readWalkthrough('anything')).toEqual({ status: 'dismissed' });
    expect(writeWalkthrough('anything', initial)).toBe(false);
  });
  it('only completes after matching recording, finalization, review and Keep', () => {
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
    writeWalkthrough('resume', stopped);
    expect(
      advanceWalkthrough(readWalkthrough('resume'), {
        type: 'recording',
        noteId: 'note-a',
        recordingId: 'new',
      })
    ).toEqual({ ...stopped, recordingId: 'new' });
  });
});
