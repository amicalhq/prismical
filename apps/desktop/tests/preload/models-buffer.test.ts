/**
 * models:stateChanged preload lane — the generic replay buffer
 * bound to ModelsStateView, pinned the way updater-buffer.test pins the updater
 * lane: the SubscriptionRef initial replay lands before any screen subscribes
 * (buffered, not dropped), a late subscriber gets the LATEST snapshot only, and
 * download progress fans out to every subscriber.
 */
import { describe, expect, it } from 'vitest';
import type { ModelsStateView } from '@prismical/desktop-contracts';
import { makeReplayBuffer, type ReplayBufferIpc } from '../../src/preload/widget-buffer';

const idle: ModelsStateView = {
  models: [
    {
      id: 'whisper-base-en',
      name: 'Whisper Base (English)',
      filename: 'ggml-base.en.bin',
      sizeBytes: 147_964_211,
      kind: 'whisper',
      recommended: true,
      installed: false,
      installedAt: null,
      download: null,
    },
  ],
  modelsDir: '/profile/models',
};
const downloading: ModelsStateView = {
  ...idle,
  models: [
    {
      ...idle.models[0],
      download: { status: 'downloading', bytesDownloaded: 1024, totalBytes: 147_964_211, error: null },
    },
  ],
};
const installed: ModelsStateView = {
  ...idle,
  models: [{ ...idle.models[0], installed: true, installedAt: '2026-09-01T00:00:00.000Z' }],
};

const makeIpc = () => {
  let handler: ((state: ModelsStateView) => void) | null = null;
  const ipc: ReplayBufferIpc<ModelsStateView> = {
    on: listener => {
      handler = listener;
    },
  };
  return { ipc, push: (state: ModelsStateView) => handler?.(state) };
};

describe('models buffer (preload)', () => {
  it('replays the push-before-subscribe on the first subscription (SubscriptionRef initial replay)', () => {
    const h = makeIpc();
    const buffer = makeReplayBuffer<ModelsStateView>(h.ipc);
    h.push(idle);
    const received: ModelsStateView[] = [];
    buffer.onState(state => received.push(state));
    expect(received).toEqual([idle]);
  });

  it('delivers progress pushes live', () => {
    const h = makeIpc();
    const buffer = makeReplayBuffer<ModelsStateView>(h.ipc);
    const received: ModelsStateView[] = [];
    buffer.onState(state => received.push(state));
    h.push(downloading);
    h.push(installed);
    expect(received).toEqual([downloading, installed]);
  });

  it('a late subscriber is seeded with the LATEST snapshot, not the progress history', () => {
    const h = makeIpc();
    const buffer = makeReplayBuffer<ModelsStateView>(h.ipc);
    const first: ModelsStateView[] = [];
    buffer.onState(state => first.push(state));
    h.push(downloading);
    h.push(installed);
    const late: ModelsStateView[] = [];
    buffer.onState(state => late.push(state));
    expect(late).toEqual([installed]);
  });

  it('a second subscriber NEVER detaches the first; unsubscribe removes only itself', () => {
    const h = makeIpc();
    const buffer = makeReplayBuffer<ModelsStateView>(h.ipc);
    const first: ModelsStateView[] = [];
    const second: ModelsStateView[] = [];
    const offFirst = buffer.onState(state => first.push(state));
    h.push(idle);
    buffer.onState(state => second.push(state));
    h.push(downloading);
    expect(first).toEqual([idle, downloading]);
    expect(second).toEqual([idle, downloading]);
    offFirst();
    h.push(installed);
    expect(first).toEqual([idle, downloading]);
    expect(second).toEqual([idle, downloading, installed]);
  });
});
