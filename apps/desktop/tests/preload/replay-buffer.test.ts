/**
 * Generic preload replay buffer — the widget:state and
 * notify:state / float:state cold-start semantics, pinned against the
 * documented contract in src/preload/widget-buffer.ts:
 *  - pushes with NO subscriber buffer; the first subscriber replays the
 *    backlog IN ORDER;
 *  - a later subscriber gets only the LATEST (snapshot semantics);
 *  - fan-out reaches every subscriber; unsubscribe removes only its own
 *    listener; a listener unsubscribing mid-fan-out doesn't perturb the round.
 */
import { describe, expect, it } from 'vitest';
import { makeReplayBuffer, type ReplayBufferIpc } from '../../src/preload/widget-buffer';

type Push = { readonly n: number };

const makeSource = () => {
  let emit: (state: Push) => void = () => {
    throw new Error('buffer never attached');
  };
  const ipc: ReplayBufferIpc<Push> = {
    on: listener => {
      emit = listener;
    },
  };
  return { ipc, push: (n: number) => emit({ n }) };
};

describe('makeReplayBuffer (preload cold-start replay)', () => {
  it('buffers pushes with no subscriber and replays the backlog in order', () => {
    const { ipc, push } = makeSource();
    const buffer = makeReplayBuffer(ipc);
    push(1);
    push(2);
    push(3);

    const seen: number[] = [];
    buffer.onState(state => seen.push(state.n));
    expect(seen).toEqual([1, 2, 3]);
  });

  it('a LATER subscriber gets only the latest state, not history', () => {
    const { ipc, push } = makeSource();
    const buffer = makeReplayBuffer(ipc);
    const first: number[] = [];
    buffer.onState(state => first.push(state.n));
    push(1);
    push(2);

    const second: number[] = [];
    buffer.onState(state => second.push(state.n));
    expect(second).toEqual([2]); // snapshot, no history replay

    push(3);
    expect(first).toEqual([1, 2, 3]);
    expect(second).toEqual([2, 3]);
  });

  it('unsubscribe removes ONLY its own listener', () => {
    const { ipc, push } = makeSource();
    const buffer = makeReplayBuffer(ipc);
    const a: number[] = [];
    const b: number[] = [];
    const offA = buffer.onState(state => a.push(state.n));
    buffer.onState(state => b.push(state.n));
    push(1);
    offA();
    push(2);
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });

  it('a listener unsubscribing mid-fan-out does not perturb the delivery round', () => {
    const { ipc, push } = makeSource();
    const buffer = makeReplayBuffer(ipc);
    const seen: string[] = [];
    const offSelf: Array<() => void> = [];
    offSelf.push(
      buffer.onState(state => {
        seen.push(`a:${state.n}`);
        offSelf[0]?.(); // self-detach during delivery
      })
    );
    buffer.onState(state => seen.push(`b:${state.n}`));
    push(1);
    // Both got push 1 (the fan-out snapshot); only b gets push 2.
    push(2);
    expect(seen).toEqual(['a:1', 'b:1', 'b:2']);
  });

  it('an empty backlog subscriber sees nothing until the first push', () => {
    const { ipc, push } = makeSource();
    const buffer = makeReplayBuffer(ipc);
    const seen: number[] = [];
    buffer.onState(state => seen.push(state.n));
    expect(seen).toEqual([]);
    push(7);
    expect(seen).toEqual([7]);
  });
});
