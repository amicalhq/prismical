/**
 * Dock geometry tests — the pure two-axis bounds/drag/snap math,
 * extending the retired widget-geometry suite.
 *
 * `computeDockBounds` (anchor → window bounds) and `dragToDockAnchor` (a drag
 * sample → anchor) are inverse pairs across the work area's margin bands — the
 * round-trip must be stable so the anchor a drag persists re-seeds the same
 * pixel spot — EXCEPT inside the 16px magnetic snap zones at the left/right
 * band edges, where the drag deliberately collapses to the edge.
 *
 * Reference work area: 1440x900 at origin ⇒
 *   x band: minX = 12, maxX = 1440-380-12 = 1048 (1036 wide);
 *   y band: minY = 24, maxY = 900-240-24 = 636 (612 tall).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOCK_ANCHOR,
  DOCK_SNAP_PX,
  DOCK_WINDOW_HEIGHT,
  DOCK_WINDOW_WIDTH,
  FLOAT_DEFAULT_HEIGHT,
  FLOAT_DEFAULT_WIDTH,
  FLOAT_MIN_HEIGHT,
  FLOAT_MIN_WIDTH,
  anchorForDisplay,
  clampAnchorAxis,
  clampDockAnchor,
  computeDockBounds,
  dragToDockAnchor,
  defaultFloatRectNearDock,
  floatBoundsToRect,
  rectToFloatBounds,
  resolveDockDisplay,
} from '../../src/main/domains/windows/dock-geometry';

const workArea = { x: 0, y: 0, width: 1440, height: 900 };
const MIN_X = 12;
const MAX_X = 1440 - DOCK_WINDOW_WIDTH - 12; // 1048
const MIN_Y = 24;
const MAX_Y = 900 - DOCK_WINDOW_HEIGHT - 24; // 636

/** A drag sample with no grab offset: the pointer IS the window origin. */
const sample = (screenX: number, screenY: number, offsetX = 0, offsetY = 0) => ({
  screenX,
  screenY,
  pointerOffsetX: offsetX,
  pointerOffsetY: offsetY,
});

describe('clampAnchorAxis / clampDockAnchor', () => {
  it('passes valid fractions through and clamps out-of-range', () => {
    expect(clampAnchorAxis(0, 1)).toBe(0);
    expect(clampAnchorAxis(0.5, 1)).toBe(0.5);
    expect(clampAnchorAxis(1, 1)).toBe(1);
    expect(clampAnchorAxis(-1, 1)).toBe(0);
    expect(clampAnchorAxis(2, 1)).toBe(1);
  });
  it('pins a non-finite value (NaN, ±∞) to the per-axis fallback', () => {
    expect(clampAnchorAxis(Number.NaN, 1)).toBe(1);
    expect(clampAnchorAxis(Number.POSITIVE_INFINITY, 0.5)).toBe(0.5);
    expect(clampAnchorAxis(Number.NaN, 0.5)).toBe(0.5);
  });
  it('clampDockAnchor defaults a missing/partial/malformed anchor per axis', () => {
    expect(clampDockAnchor(undefined)).toEqual(DEFAULT_DOCK_ANCHOR);
    expect(clampDockAnchor(null)).toEqual(DEFAULT_DOCK_ANCHOR);
    expect(clampDockAnchor({ nx: 0.3 })).toEqual({ nx: 0.3, ny: DEFAULT_DOCK_ANCHOR.ny });
    expect(clampDockAnchor({ nx: 7, ny: -3 })).toEqual({ nx: 1, ny: 0 });
  });
});

describe('computeDockBounds', () => {
  it('projects both axes linearly across the margin bands (fixed size)', () => {
    expect(computeDockBounds(workArea, { nx: 0, ny: 0 })).toEqual({
      x: MIN_X,
      y: MIN_Y,
      width: DOCK_WINDOW_WIDTH,
      height: DOCK_WINDOW_HEIGHT,
    });
    expect(computeDockBounds(workArea, { nx: 1, ny: 1 })).toEqual({
      x: MAX_X,
      y: MAX_Y,
      width: DOCK_WINDOW_WIDTH,
      height: DOCK_WINDOW_HEIGHT,
    });
    const mid = computeDockBounds(workArea, { nx: 0.5, ny: 0.5 });
    expect(mid.x).toBe(Math.round(MIN_X + (MAX_X - MIN_X) * 0.5)); // 530
    expect(mid.y).toBe(330);
  });

  it('the legacy right-edge seed (nx: 1) lands exactly on the old widget x', () => {
    // Match the legacy position: x = workArea right - width - 12.
    expect(computeDockBounds(workArea, { nx: 1, ny: 0.25 })).toEqual({
      x: 1048,
      y: 177,
      width: DOCK_WINDOW_WIDTH,
      height: DOCK_WINDOW_HEIGHT,
    });
  });

  it('clamps out-of-range and defaults non-finite anchor axes (right/centre)', () => {
    expect(computeDockBounds(workArea, { nx: 2, ny: -1 })).toMatchObject({ x: MAX_X, y: MIN_Y });
    expect(computeDockBounds(workArea, { nx: Number.NaN, ny: Number.NaN })).toMatchObject({
      x: MAX_X, // nx falls back to 1 (right)
      y: 330, // ny falls back to 0.5 (centre)
    });
  });

  it('a collapsed band (window larger than usable area) pins to the min margin', () => {
    const tiny = { x: 0, y: 0, width: 300, height: 200 };
    expect(computeDockBounds(tiny, { nx: 0.5, ny: 0.5 })).toMatchObject({ x: 12, y: 24 });
  });

  it('honours a non-zero work-area origin (multi-display)', () => {
    const offset = { x: 1440, y: -200, width: 1440, height: 900 };
    expect(computeDockBounds(offset, { nx: 0, ny: 0 })).toMatchObject({
      x: 1440 + 12,
      y: -200 + 24,
    });
    expect(computeDockBounds(offset, { nx: 1, ny: 1 })).toMatchObject({
      x: 1440 + 1048,
      y: -200 + 636,
    });
  });
});

describe('dragToDockAnchor', () => {
  it('projects the window origin (screen - pointerOffset) onto both bands', () => {
    expect(dragToDockAnchor(workArea, sample(530, 330))).toEqual({ nx: 0.5, ny: 0.5 });
    // Grab offset held under the pointer: origin = (630-100, 430-100) = (530, 330).
    expect(dragToDockAnchor(workArea, sample(630, 430, 100, 100))).toEqual({ nx: 0.5, ny: 0.5 });
  });

  it('clamps a pointer outside the bands to the corners', () => {
    expect(dragToDockAnchor(workArea, sample(-5_000, -5_000))).toEqual({ nx: 0, ny: 0 });
    expect(dragToDockAnchor(workArea, sample(10_000, 10_000))).toEqual({ nx: 1, ny: 1 });
  });

  it('magnetically snaps within 16px of the left/right band edges — never vertically', () => {
    // Left: x = 28 (= MIN_X + 16) snaps flush; x = 29 does not.
    expect(dragToDockAnchor(workArea, sample(MIN_X + DOCK_SNAP_PX, 330)).nx).toBe(0);
    expect(dragToDockAnchor(workArea, sample(MIN_X + DOCK_SNAP_PX + 1, 330)).nx).toBeCloseTo(
      (DOCK_SNAP_PX + 1) / (MAX_X - MIN_X),
      10
    );
    // Right: x = 1032 (= MAX_X - 16) snaps flush; x = 1031 does not.
    expect(dragToDockAnchor(workArea, sample(MAX_X - DOCK_SNAP_PX, 330)).nx).toBe(1);
    expect(dragToDockAnchor(workArea, sample(MAX_X - DOCK_SNAP_PX - 1, 330)).nx).toBeLessThan(1);
    // Vertical: 16px from the top band edge does NOT snap.
    expect(dragToDockAnchor(workArea, sample(530, MIN_Y + DOCK_SNAP_PX)).ny).toBeCloseTo(
      DOCK_SNAP_PX / (MAX_Y - MIN_Y),
      10
    );
  });

  it('collapsed bands pin to 1 (legacy dragToNormalizedY parity)', () => {
    const tiny = { x: 0, y: 0, width: 300, height: 200 };
    expect(dragToDockAnchor(tiny, sample(100, 100))).toEqual({ nx: 1, ny: 1 });
  });

  it('round-trips with computeDockBounds outside the snap zones (pixel-stable)', () => {
    for (const nx of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      for (const ny of [0, 0.25, 0.5, 0.75, 1]) {
        const b = computeDockBounds(workArea, { nx, ny });
        const back = dragToDockAnchor(workArea, sample(b.x, b.y));
        // The anchor is within one pixel's worth of band fraction…
        expect(back.nx).toBeCloseTo(nx, 2);
        expect(back.ny).toBeCloseTo(ny, 2);
        // …and THE invariant: re-seeding the persisted anchor lands on the
        // exact same pixel spot (a drag release never shifts the window).
        expect(computeDockBounds(workArea, back)).toEqual(b);
      }
    }
  });

  it('inside a snap zone the round-trip collapses to the edge (by design)', () => {
    const b = computeDockBounds(workArea, { nx: 0.01, ny: 0.5 }); // x=22, within 16px of 12
    expect(dragToDockAnchor(workArea, sample(b.x, b.y)).nx).toBe(0);
  });
});

describe('resolveDockDisplay / anchorForDisplay (per-display persistence)', () => {
  const d1 = { id: 1, workArea };
  const d2 = { id: 2, workArea: { x: 1440, y: 0, width: 2560, height: 1440 } };

  it('resolves the saved display when still connected, else the primary', () => {
    expect(resolveDockDisplay([d1, d2], d1, '2')).toBe(d2);
    expect(resolveDockDisplay([d1, d2], d1, '1')).toBe(d1);
    expect(resolveDockDisplay([d1, d2], d1, '99')).toBe(d1); // vanished display
    expect(resolveDockDisplay([d1, d2], d1, null)).toBe(d1); // nothing saved
  });

  it('uses the saved per-display anchor when present (clamped)', () => {
    const anchors = { '2': { nx: 0.3, ny: 0.7 }, '3': { nx: 9, ny: -9 } };
    expect(anchorForDisplay(anchors, '2', 0.25)).toEqual({ nx: 0.3, ny: 0.7 });
    expect(anchorForDisplay(anchors, '3', 0.25)).toEqual({ nx: 1, ny: 0 });
  });

  it('seeds a display with no entry from the legacy widgetNormalizedY (right edge)', () => {
    // Legacy-position compatibility: right edge at the old row, read-side only.
    expect(anchorForDisplay({}, '1', 0.25)).toEqual({ nx: 1, ny: 0.25 });
    expect(anchorForDisplay({ '2': { nx: 0, ny: 0 } }, '1', 0.8)).toEqual({ nx: 1, ny: 0.8 });
    // A garbage legacy value still yields a sane centre.
    expect(anchorForDisplay({}, '1', Number.NaN)).toEqual({ nx: 1, ny: 0.5 });
  });
});

describe('floatBoundsToRect / rectToFloatBounds', () => {
  it('no saved bounds → the default size centred', () => {
    expect(floatBoundsToRect(workArea, undefined)).toEqual({
      x: Math.round((1440 - FLOAT_DEFAULT_WIDTH) / 2), // 530
      y: Math.round((900 - FLOAT_DEFAULT_HEIGHT) / 2), // 190
      width: FLOAT_DEFAULT_WIDTH,
      height: FLOAT_DEFAULT_HEIGHT,
    });
  });

  it('applies saved normalized bounds across the full work-area bands', () => {
    expect(floatBoundsToRect(workArea, { nx: 0, ny: 0, nw: 0.5, nh: 0.5 })).toEqual({
      x: 0,
      y: 0,
      width: 720,
      height: 450,
    });
    expect(floatBoundsToRect(workArea, { nx: 1, ny: 1, nw: 0.25, nh: 0.5 })).toEqual({
      x: 1440 - 360,
      y: 900 - 450,
      width: 360,
      height: 450,
    });
  });

  it('clamps the size to the minimum and to the work area', () => {
    const small = floatBoundsToRect(workArea, { nx: 0.5, ny: 0.5, nw: 0.01, nh: 0.01 });
    expect(small.width).toBe(FLOAT_MIN_WIDTH);
    expect(small.height).toBe(FLOAT_MIN_HEIGHT);
    const huge = floatBoundsToRect(workArea, { nx: 0.5, ny: 0.5, nw: 5, nh: 5 });
    expect(huge.width).toBe(1440);
    expect(huge.height).toBe(900);
    expect(huge).toMatchObject({ x: 0, y: 0 });
  });

  it('malformed saved values (non-finite) fall back per part', () => {
    const rect = floatBoundsToRect(workArea, { nx: Number.NaN, ny: 0, nw: Number.NaN, nh: 0.5 });
    expect(rect.width).toBe(FLOAT_DEFAULT_WIDTH); // nw fell back
    expect(rect.height).toBe(450);
    expect(rect.y).toBe(0);
    expect(rect.x).toBe(Math.round((1440 - FLOAT_DEFAULT_WIDTH) / 2)); // nx fell back to centre
  });

  it('round-trips rect → normalized → rect on the same work area', () => {
    for (const rect of [
      { x: 100, y: 50, width: 400, height: 500 },
      { x: 0, y: 0, width: FLOAT_MIN_WIDTH, height: FLOAT_MIN_HEIGHT },
      { x: 1040, y: 380, width: 400, height: 520 },
    ]) {
      expect(floatBoundsToRect(workArea, rectToFloatBounds(workArea, rect))).toEqual(rect);
    }
  });

  it('a window larger than the work area persists full-size at the origin band', () => {
    const norm = rectToFloatBounds(workArea, { x: -50, y: -50, width: 2000, height: 1200 });
    expect(norm).toMatchObject({ nw: 1, nh: 1, nx: 0, ny: 0 });
    expect(floatBoundsToRect(workArea, norm)).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
  });

  it('honours a non-zero work-area origin (multi-display)', () => {
    const offset = { x: 1440, y: -200, width: 2560, height: 1440 };
    const rect = { x: 1440 + 200, y: -200 + 100, width: 500, height: 600 };
    expect(floatBoundsToRect(offset, rectToFloatBounds(offset, rect))).toEqual(rect);
  });
});

describe('defaultFloatRectNearDock (first-open placement beside the pill)', () => {
  it('a RIGHT-docked pill puts the float on its left, vertically centred', () => {
    // dock at nx=1,ny=0.5 → (1048, 330); pill zone hugs the window's right
    // edge, so the float's right edge sits 128px (zone+gap) inside it.
    expect(defaultFloatRectNearDock(workArea, { nx: 1, ny: 0.5 })).toEqual({
      x: 1048 + 380 - 120 - 8 - 380, // 920
      y: 330 + 120 - 260, // 190 — centred on the dock window
      width: 380,
      height: 520,
    });
  });

  it('a LEFT-docked pill puts the float on its right', () => {
    expect(defaultFloatRectNearDock(workArea, { nx: 0, ny: 0.5 })).toEqual({
      x: 12 + 120 + 8, // 140
      y: 190,
      width: 380,
      height: 520,
    });
  });

  it('a pill near the top edge pushes the float DOWN into the work area', () => {
    expect(defaultFloatRectNearDock(workArea, { nx: 1, ny: 0 })).toEqual({
      x: 920,
      y: 0, // rawY would be negative — clamped to the work-area top
      width: 380,
      height: 520,
    });
  });
});
