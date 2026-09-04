// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

// The hook resolves the platform off navigator.userAgent and caches it inside
// the module, so each platform gets its own module instance.
async function loadOn(platform: 'mac' | 'windows') {
  vi.resetModules();
  vi.stubGlobal('navigator', {
    userAgent:
      platform === 'mac'
        ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  });
  return (await import('./shortcuts')).useIsModHeld;
}

afterEach(() => vi.unstubAllGlobals());

describe('useIsModHeld', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  });

  it('follows the ⌘ modifier on Apple platforms', async () => {
    const hook = await loadOn('mac');
    const { result } = renderHook(() => hook());

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
    });
    expect(result.current).toBe(true);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', metaKey: false }));
    });
    expect(result.current).toBe(false);
  });

  it('reads Ctrl, not ⌘, off Apple platforms', async () => {
    const hook = await loadOn('windows');
    const { result } = renderHook(() => hook());

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
    });
    expect(result.current).toBe(false);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
    });
    expect(result.current).toBe(true);
  });

  // macOS suppresses keyup for the second key while ⌘ is down, so the state has
  // to come off the modifier flag of whatever event does arrive — not a
  // per-key press/release ledger, which would desync on the first ⌘K.
  it('stays held through a full chord where the second keyup never lands', async () => {
    const hook = await loadOn('mac');
    const { result } = renderHook(() => hook());

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    });
    expect(result.current).toBe(true);
  });

  it('resets on blur, so ⌘Tab cannot leave the hints stuck open', async () => {
    const hook = await loadOn('mac');
    const { result } = renderHook(() => hook());

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
    });
    expect(result.current).toBe(true);

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(result.current).toBe(false);
  });

  it('resets when the tab is hidden', async () => {
    const hook = await loadOn('mac');
    const { result } = renderHook(() => hook());

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
    });
    expect(result.current).toBe(true);

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current).toBe(false);
  });
});
