import { describe, expect, it } from 'vitest';
import type { SessionView } from '@prismical/desktop-contracts';
import { makeSessionBuffer, type SessionBufferIpc } from '../../src/preload/session-buffer';

const signedOut: SessionView = { state: 'signed-out', accounts: [] };
const signingIn: SessionView = { state: 'signing-in', accounts: [] };
const signedIn: SessionView = {
  state: 'signed-in',
  accounts: [{ sub: 'user_1', email: 'u1@example.com' }],
  activeSub: 'user_1',
};

const makeIpc = () => {
  let handler: ((view: SessionView) => void) | null = null;
  const ipc: SessionBufferIpc = {
    on: listener => {
      handler = listener;
    },
  };
  return { ipc, push: (view: SessionView) => handler?.(view) };
};

describe('session buffer (preload)', () => {
  it('replays push-before-subscribe on the first subscription (cold start)', () => {
    const h = makeIpc();
    const buffer = makeSessionBuffer(h.ipc);
    h.push(signingIn);
    h.push(signedIn);
    const received: SessionView[] = [];
    buffer.onSessionChanged(view => received.push(view));
    expect(received).toEqual([signingIn, signedIn]);
  });

  it('delivers push-after-subscribe live', () => {
    const h = makeIpc();
    const buffer = makeSessionBuffer(h.ipc);
    const received: SessionView[] = [];
    buffer.onSessionChanged(view => received.push(view));
    h.push(signedIn);
    expect(received).toEqual([signedIn]);
  });

  it('unsubscribe stops delivery', () => {
    const h = makeIpc();
    const buffer = makeSessionBuffer(h.ipc);
    const received: SessionView[] = [];
    const off = buffer.onSessionChanged(view => received.push(view));
    off();
    h.push(signedOut);
    expect(received).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Multi-subscriber contract (the single-subscriber "latest wins"
  // slot silently detached the gate when the sentinel spec attached a capture)
  // ---------------------------------------------------------------------------

  it('a second subscriber never detaches the first', () => {
    const h = makeIpc();
    const buffer = makeSessionBuffer(h.ipc);
    const first: SessionView[] = [];
    const second: SessionView[] = [];
    buffer.onSessionChanged(view => first.push(view));
    h.push(signingIn);
    buffer.onSessionChanged(view => second.push(view));
    h.push(signedIn);
    // The first subscriber kept receiving after the second attached…
    expect(first).toEqual([signingIn, signedIn]);
    // …and the second got the latest view on attach, then the live push.
    expect(second).toEqual([signingIn, signedIn]);
  });

  it('a late subscriber is seeded with the LATEST view, not the full history', () => {
    const h = makeIpc();
    const buffer = makeSessionBuffer(h.ipc);
    const first: SessionView[] = [];
    buffer.onSessionChanged(view => first.push(view));
    h.push(signingIn);
    h.push(signedIn);
    const late: SessionView[] = [];
    buffer.onSessionChanged(view => late.push(view));
    expect(late).toEqual([signedIn]);
  });

  it('the cold-start backlog replays in order to the first subscriber only', () => {
    const h = makeIpc();
    const buffer = makeSessionBuffer(h.ipc);
    h.push(signingIn);
    h.push(signedIn);
    const first: SessionView[] = [];
    const second: SessionView[] = [];
    buffer.onSessionChanged(view => first.push(view));
    buffer.onSessionChanged(view => second.push(view));
    expect(first).toEqual([signingIn, signedIn]);
    // No duplicate replay — the late subscriber gets the latest snapshot.
    expect(second).toEqual([signedIn]);
  });

  it('unsubscribing one subscriber leaves the others attached', () => {
    const h = makeIpc();
    const buffer = makeSessionBuffer(h.ipc);
    const first: SessionView[] = [];
    const second: SessionView[] = [];
    const offFirst = buffer.onSessionChanged(view => first.push(view));
    buffer.onSessionChanged(view => second.push(view));
    offFirst();
    h.push(signedOut);
    expect(first).toEqual([]);
    expect(second).toEqual([signedOut]);
  });

  it('pushes while ALL subscribers are gone buffer and replay to the next one', () => {
    const h = makeIpc();
    const buffer = makeSessionBuffer(h.ipc);
    const first: SessionView[] = [];
    const off = buffer.onSessionChanged(view => first.push(view));
    h.push(signedIn);
    off();
    h.push(signingIn);
    h.push(signedOut);
    const next: SessionView[] = [];
    buffer.onSessionChanged(view => next.push(view));
    expect(next).toEqual([signingIn, signedOut]);
  });
});
