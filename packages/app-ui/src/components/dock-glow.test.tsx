// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const fresh = vi.hoisted(() => new Set<string>());
vi.mock('@prismical/app-client', () => ({
  consumeFreshNote: (id: string) => fresh.delete(id),
}));

// The glow's once-per-load state is module-scoped, so each test gets a fresh module.
async function loadHook() {
  vi.resetModules();
  return (await import('./dock-glow')).useDockArrivalGlow;
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  fresh.clear();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
  setHidden(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useDockArrivalGlow', () => {
  it('lights the whole dock once on load, then goes out', async () => {
    const useGlow = await loadHook();
    const { result } = renderHook(() => useGlow(null));
    expect(result.current).toMatchObject({ active: true, scope: 'dock' });
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current.active).toBe(false);

    // A later dock mount in the same load does not replay it.
    const second = renderHook(() => useGlow(null));
    expect(second.result.current.active).toBe(false);
  });

  it('picks the load glow back up when the dock remounts mid-glow', async () => {
    const useGlow = await loadHook();
    const first = renderHook(() => useGlow(null));
    act(() => vi.advanceTimersByTime(1000));
    first.unmount();
    const { result } = renderHook(() => useGlow(null));
    expect(result.current.active).toBe(true);
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.active).toBe(false);
  });

  it('waits for a hidden page to become visible before playing', async () => {
    setHidden(true);
    const useGlow = await loadHook();
    const { result } = renderHook(() => useGlow(null));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.active).toBe(false);
    act(() => setHidden(false));
    expect(result.current).toMatchObject({ active: true, scope: 'dock' });
  });

  it('lights only Record, briefly, when a newly created note opens', async () => {
    const useGlow = await loadHook();
    const { result, rerender } = renderHook(({ noteId }) => useGlow(noteId), {
      initialProps: { noteId: null as string | null },
    });
    act(() => result.current.stop());
    fresh.add('nt_new');
    rerender({ noteId: 'nt_new' });
    expect(result.current).toMatchObject({ active: true, scope: 'record' });
    act(() => vi.advanceTimersByTime(2400));
    expect(result.current.active).toBe(false);

    // Reopening the same note later is not "new" any more.
    rerender({ noteId: null });
    rerender({ noteId: 'nt_new' });
    expect(result.current.active).toBe(false);
  });

  it('ends early when the user reaches for the dock', async () => {
    const useGlow = await loadHook();
    const { result } = renderHook(() => useGlow(null));
    expect(result.current.active).toBe(true);
    act(() => result.current.stop());
    expect(result.current.active).toBe(false);
  });

  it('never plays on a disabled dock, and leaves the load glow and new notes to the main dock', async () => {
    const useGlow = await loadHook();
    fresh.add('nt_new');
    const { result } = renderHook(() => useGlow('nt_new', false));
    expect(result.current.active).toBe(false);
    expect(fresh.has('nt_new')).toBe(true);

    // The main dock's load glow waits for the page to show; the disabled dock must not take it.
    act(() => setHidden(true));
    const main = renderHook(() => useGlow(null));
    act(() => setHidden(false));
    expect(result.current.active).toBe(false);
    expect(main.result.current).toMatchObject({ active: true, scope: 'dock' });
  });

  it('does not pick up a glow the main dock is playing when disabled', async () => {
    const useGlow = await loadHook();
    const main = renderHook(() => useGlow(null));
    act(() => vi.advanceTimersByTime(1000));
    expect(main.result.current.active).toBe(true);
    const disabled = renderHook(() => useGlow(null, false));
    expect(disabled.result.current.active).toBe(false);

    // Nor can it end that glow: a remount of the main dock still picks it back up.
    act(() => disabled.result.current.stop());
    expect(renderHook(() => useGlow(null)).result.current.active).toBe(true);
  });

  it('never plays under reduced motion', async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    const useGlow = await loadHook();
    const { result } = renderHook(() => useGlow(null));
    expect(result.current.active).toBe(false);
  });
});
