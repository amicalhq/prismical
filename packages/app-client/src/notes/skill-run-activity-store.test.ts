import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSkillRunActivityStore } from './skill-run-activity-store';

const NOTE = 'nt_1';

type BeginArgs = Parameters<ReturnType<typeof useSkillRunActivityStore.getState>['begin']>[0];

function begin(overrides: Partial<BeginArgs> = {}) {
  return useSkillRunActivityStore.getState().begin({
    noteId: NOTE,
    skillId: 'sk_cleanup',
    skillName: 'Cleanup',
    source: 'chip',
    ...overrides,
  });
}

const runs = () => useSkillRunActivityStore.getState().runsByNote.get(NOTE) ?? [];

describe('skill run feed (useSkillRunActivityStore)', () => {
  beforeEach(() => {
    useSkillRunActivityStore.setState({
      runningByNote: new Map(),
      runsByNote: new Map(),
    });
  });

  it('opens a running record and closes it with the first terminal status only', () => {
    const id = begin();
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({
      id,
      status: 'running',
      skillName: 'Cleanup',
    });

    useSkillRunActivityStore.getState().finish(id, 'staged');
    expect(runs()[0]).toMatchObject({ status: 'staged' });
    expect(runs()[0]!.endedAt).toBeTypeOf('number');

    // The catch-all in `finally` fires after the explicit finish — it must not overwrite it.
    useSkillRunActivityStore.getState().finish(id, 'error', 'late');
    expect(runs()[0]).toMatchObject({ status: 'staged' });
    expect(runs()[0]!.detail).toBeUndefined();
  });

  it('drops the cancel handle once the run settles', () => {
    const cancel = vi.fn();
    const id = begin({ cancel });
    expect(runs()[0]!.cancel).toBe(cancel);
    useSkillRunActivityStore.getState().finish(id, 'stopped');
    expect(runs()[0]!.cancel).toBeUndefined();
  });

  it('resolves the latest staged record on Keep / Undo', () => {
    const a = begin();
    useSkillRunActivityStore.getState().finish(a, 'staged');
    useSkillRunActivityStore.getState().resolveStaged(NOTE, 'kept');
    expect(runs()[0]).toMatchObject({ status: 'kept' });

    const b = begin();
    useSkillRunActivityStore.getState().finish(b, 'staged');
    useSkillRunActivityStore.getState().resolveStaged(NOTE, 'undone');
    expect(runs()[1]).toMatchObject({ status: 'undone' });
    // Nothing staged any more — a stray resolve is a no-op.
    useSkillRunActivityStore.getState().resolveStaged(NOTE, 'kept');
    expect(runs().map(r => r.status)).toEqual(['kept', 'undone']);
  });

  it('supersedes the previous staged candidate only once a refine actually stages', () => {
    const a = begin();
    useSkillRunActivityStore.getState().finish(a, 'staged');
    const b = begin({ source: 'refine', instruction: 'shorter' });
    // Refine in flight: the earlier candidate is still the live one.
    expect(runs().map(r => r.status)).toEqual(['staged', 'running']);
    expect(runs()[1]).toMatchObject({
      id: b,
      instruction: 'shorter',
      source: 'refine',
    });
    useSkillRunActivityStore.getState().finish(b, 'staged');
    expect(runs().map(r => r.status)).toEqual(['superseded', 'staged']);
  });

  it('a failed refine leaves the earlier candidate resolvable by Keep/Undo', () => {
    const a = begin();
    useSkillRunActivityStore.getState().finish(a, 'staged');
    const b = begin({ source: 'refine' });
    useSkillRunActivityStore.getState().finish(b, 'error', 'boom');
    useSkillRunActivityStore.getState().resolveStaged(NOTE, 'kept');
    expect(runs().map(r => r.status)).toEqual(['kept', 'error']);
  });

  it('re-anchors only while running; a settled record keeps its first anchor', () => {
    const id = begin();
    useSkillRunActivityStore.getState().anchor(id, { conversationId: 'cnv_1', afterMessageId: '' });
    useSkillRunActivityStore
      .getState()
      .anchor(id, { conversationId: 'cnv_2', afterMessageId: 'm9' });
    expect(runs()[0]!.anchor).toEqual({
      conversationId: 'cnv_2',
      afterMessageId: 'm9',
    });
    useSkillRunActivityStore.getState().finish(id, 'staged');
    useSkillRunActivityStore
      .getState()
      .anchor(id, { conversationId: 'cnv_3', afterMessageId: 'm1' });
    expect(runs()[0]!.anchor).toEqual({
      conversationId: 'cnv_2',
      afterMessageId: 'm9',
    });
  });

  it('keeps the in-flight counter independent of the feed (title runs count but never appear)', () => {
    const s = useSkillRunActivityStore.getState();
    s.start(NOTE);
    s.start(NOTE);
    expect(useSkillRunActivityStore.getState().runningByNote.get(NOTE)).toBe(2);
    s.stop(NOTE);
    expect(useSkillRunActivityStore.getState().runningByNote.get(NOTE)).toBe(1);
    s.stop(NOTE);
    expect(useSkillRunActivityStore.getState().runningByNote.has(NOTE)).toBe(false);
    expect(runs()).toHaveLength(0);
  });

  it('caps the feed per note', () => {
    for (let i = 0; i < 25; i++) {
      const id = begin();
      useSkillRunActivityStore.getState().finish(id, 'undone');
    }
    expect(runs()).toHaveLength(20);
  });
});
