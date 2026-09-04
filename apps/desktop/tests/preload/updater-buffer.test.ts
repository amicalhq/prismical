import { describe, expect, it } from 'vitest';
import type { UpdateStateView } from '@prismical/desktop-contracts';
import { makeUpdaterBuffer, type UpdaterBufferIpc } from '../../src/preload/updater-buffer';

const notAvailable: UpdateStateView = {
  status: 'not-available',
  staged: false,
  stagedVersion: null,
  prompt: null,
};
const downloaded: UpdateStateView = {
  status: 'downloaded',
  staged: true,
  stagedVersion: '0.2.0',
  prompt: { action: 'prompt', version: '0.2.0', releaseNotes: 'notes' },
};

const makeIpc = () => {
  let handler: ((state: UpdateStateView) => void) | null = null;
  const ipc: UpdaterBufferIpc = {
    on: listener => {
      handler = listener;
    },
  };
  return { ipc, push: (state: UpdateStateView) => handler?.(state) };
};

describe('updater buffer (preload)', () => {
  it('replays the push-before-subscribe on the first subscription (SubscriptionRef initial replay)', () => {
    const h = makeIpc();
    const buffer = makeUpdaterBuffer(h.ipc);
    h.push(notAvailable);
    const received: UpdateStateView[] = [];
    buffer.onChanged(state => received.push(state));
    expect(received).toEqual([notAvailable]);
  });

  it('delivers push-after-subscribe live', () => {
    const h = makeIpc();
    const buffer = makeUpdaterBuffer(h.ipc);
    const received: UpdateStateView[] = [];
    buffer.onChanged(state => received.push(state));
    h.push(downloaded);
    expect(received).toEqual([downloaded]);
  });

  it('a late subscriber is seeded with the LATEST view, not the full history', () => {
    const h = makeIpc();
    const buffer = makeUpdaterBuffer(h.ipc);
    const first: UpdateStateView[] = [];
    buffer.onChanged(state => first.push(state));
    h.push(notAvailable);
    h.push(downloaded);
    const late: UpdateStateView[] = [];
    buffer.onChanged(state => late.push(state));
    expect(late).toEqual([downloaded]);
  });

  it('a second subscriber NEVER detaches the first', () => {
    const h = makeIpc();
    const buffer = makeUpdaterBuffer(h.ipc);
    const first: UpdateStateView[] = [];
    const second: UpdateStateView[] = [];
    buffer.onChanged(state => first.push(state));
    h.push(notAvailable);
    buffer.onChanged(state => second.push(state));
    h.push(downloaded);
    expect(first).toEqual([notAvailable, downloaded]);
    expect(second).toEqual([notAvailable, downloaded]);
  });

  it('unsubscribe stops delivery for that listener only', () => {
    const h = makeIpc();
    const buffer = makeUpdaterBuffer(h.ipc);
    const first: UpdateStateView[] = [];
    const second: UpdateStateView[] = [];
    const offFirst = buffer.onChanged(state => first.push(state));
    buffer.onChanged(state => second.push(state));
    offFirst();
    h.push(downloaded);
    expect(first).toEqual([]);
    expect(second).toEqual([downloaded]);
  });
});
