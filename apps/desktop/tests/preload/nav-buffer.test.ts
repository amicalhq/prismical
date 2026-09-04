import { describe, expect, it } from 'vitest';
import type { NavPush } from '@prismical/desktop-contracts';
import { makeNavBuffer, type NavBufferIpc } from '../../src/preload/nav-buffer';

const makeIpc = () => {
  let handler: ((payload: NavPush) => void) | null = null;
  const ipc: NavBufferIpc = {
    on: listener => {
      handler = listener;
    },
  };
  return { ipc, push: (payload: NavPush) => handler?.(payload) };
};

describe('nav buffer (preload)', () => {
  it('replays push-before-subscribe on the first subscription (cold start)', () => {
    const h = makeIpc();
    const buffer = makeNavBuffer(h.ipc);
    h.push({ path: '/a' });
    h.push({ path: '/b' });
    const received: NavPush[] = [];
    buffer.onPush(p => received.push(p));
    expect(received).toEqual([{ path: '/a' }, { path: '/b' }]);
  });

  it('delivers push-after-subscribe live', () => {
    const h = makeIpc();
    const buffer = makeNavBuffer(h.ipc);
    const received: NavPush[] = [];
    buffer.onPush(p => received.push(p));
    h.push({ path: '/c' });
    expect(received).toEqual([{ path: '/c' }]);
  });

  it('unsubscribe stops delivery', () => {
    const h = makeIpc();
    const buffer = makeNavBuffer(h.ipc);
    const received: NavPush[] = [];
    const off = buffer.onPush(p => received.push(p));
    off();
    h.push({ path: '/d' });
    expect(received).toEqual([]);
  });
});
