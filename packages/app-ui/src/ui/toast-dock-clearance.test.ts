import { describe, expect, it } from 'vitest';
import { toastDockClearance } from './toast-dock-clearance';

const dock = { left: 800, right: 1200, top: 842, bottom: 884 };

describe('toast clearance around the dock', () => {
  it('keeps the corner offset when there is room beside the dock', () => {
    expect(toastDockClearance(900, { left: 1300, right: 1656 }, [dock])).toBe(16);
  });
  it('clears overlapping controls by only the required gap', () => {
    expect(toastDockClearance(900, { left: 1100, right: 1456 }, [dock])).toBe(70);
  });
  it('follows expanded panels and additional visible notices', () => {
    expect(
      toastDockClearance(900, { left: 1100, right: 1456 }, [
        { ...dock, top: 444 },
        { ...dock, top: 400, bottom: 430 },
      ])
    ).toBe(512);
  });
  it('returns to the corner when the dock unmounts', () => {
    expect(toastDockClearance(900, { left: 1100, right: 1456 }, [])).toBe(16);
  });
  it('ignores collapsed obstacles', () => {
    expect(toastDockClearance(900, { left: 1100, right: 1456 }, [{ ...dock, right: 800 }])).toBe(
      16
    );
  });
  it('keeps a gap even when the dock nearly touches the toast', () => {
    expect(toastDockClearance(900, { left: 1206, right: 1562 }, [dock])).toBe(70);
  });
});
