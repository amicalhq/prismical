/**
 * Dock geometry — pure functions, no Electron. The pill is no longer pinned to
 * the right edge —
 * it drags freely on BOTH axes, persisted as a 2-axis normalized anchor
 * PER DISPLAY (`dockAnchors[displayId]`, plus `dockDisplayId` = the display the
 * dock last lived on). Kept electron-free so the bounds/drag/snap math is
 * exhaustively unit-testable (dock-geometry.test.ts) like widget-policy.ts.
 *
 * The two directions are inverse pairs across the work area's margin bands:
 *  - `computeDockBounds(workArea, anchor)` — a {nx, ny} anchor → window bounds
 *    (seeds the window at open from the persisted per-display anchor);
 *  - `dragToDockAnchor(workArea, sample)` — a 2-axis drag sample → the anchor to
 *    apply/persist, with a 16px MAGNETIC SNAP to the left/right band edges
 *    (vertical never snaps). Snap lives here (not only on release) so the pull
 *    is felt live during the drag — both dragMove and dragEnd share this math.
 *
 * Also hosts the pure halves of per-display persistence:
 *  - `resolveDockDisplay` — saved display id → live display, primary fallback
 *    (display-vanish never strands the dock off-screen);
 *  - `anchorForDisplay` — saved anchor for a display, else the legacy-seeded
 *    default (right edge at the old `widgetNormalizedY` row — the migration uses
 *    this read-side fallback; nothing rewrites stored rows);
 *  - `floatBoundsToRect` / `rectToFloatBounds` — the floating note's persisted
 *    normalized bounds (`floatNoteBounds[displayId]`): position
 *    normalized across the work-area band, size as a work-area fraction, clamped
 *    to the min size and the work area.
 */

/** Dock (pill) window dimensions — constants, not user-tunable. */
export const DOCK_WINDOW_WIDTH = 380;
export const DOCK_WINDOW_HEIGHT = 240;
/** Minimum gap from the left/right work-area edges (the horizontal clamp). */
export const DOCK_EDGE_MARGIN = 12;
/** Minimum gap from the top/bottom work-area edges (the vertical clamp). */
export const DOCK_V_MARGIN = 24;
/** Magnetic snap distance to the left/right band edges (px). */
export const DOCK_SNAP_PX = 16;

/** Floating-note window sizing. */
export const FLOAT_DEFAULT_WIDTH = 380;
export const FLOAT_DEFAULT_HEIGHT = 520;
export const FLOAT_MIN_WIDTH = 320;
export const FLOAT_MIN_HEIGHT = 360;

/** Notify (notification card) window sizing: 336px cards + 12px gutters. */
export const NOTIFY_WINDOW_WIDTH = 360;
/** Room for the max 3-card stack (3×~56px rows + gaps + top margin). */
export const NOTIFY_WINDOW_HEIGHT = 244;
export const NOTIFY_MARGIN = 12;
/** In-window padding the renderer reserves (card shadow room, pr/pt-2 = 8px). */
export const NOTIFY_CARD_INSET = 8;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A 2-axis normalized anchor within a display's margin bands (0..1 each). */
export interface DockAnchor {
  readonly nx: number;
  readonly ny: number;
}

/** The seed when nothing is persisted: right edge, vertically centred. */
export const DEFAULT_DOCK_ANCHOR: DockAnchor = { nx: 1, ny: 0.5 };

/**
 * The floating note's persisted normalized bounds: position across the
 * work-area band (like DockAnchor) + size as a fraction of the work area.
 */
export interface FloatNormBounds {
  readonly nx: number;
  readonly ny: number;
  readonly nw: number;
  readonly nh: number;
}

/**
 * Clamp one anchor axis; a non-finite value pins to `fallback` (the legacy
 * clampNormalizedY pinned to the bottom — the same stance, per axis).
 */
export const clampAnchorAxis = (value: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

/** Clamp a whole anchor; a missing/malformed anchor falls to the default. */
export const clampDockAnchor = (anchor: Partial<DockAnchor> | null | undefined): DockAnchor => ({
  nx: clampAnchorAxis(anchor?.nx ?? Number.NaN, DEFAULT_DOCK_ANCHOR.nx),
  ny: clampAnchorAxis(anchor?.ny ?? Number.NaN, DEFAULT_DOCK_ANCHOR.ny),
});

/** One axis of the linear band projection: anchor fraction → pixel origin. */
const bandToPixel = (min: number, max: number, fraction: number): number =>
  max <= min ? min : Math.round(min + (max - min) * fraction);

/**
 * Dock window bounds within a display work area, both origins a fraction of the
 * usable bands (margins subtracted). Linear so it is the exact inverse of
 * `dragToDockAnchor`: the anchor a drag persists re-seeds the same pixel spot.
 * A collapsed band (window larger than the usable area) pins to the min margin.
 */
export const computeDockBounds = (workArea: Rect, anchor: DockAnchor): Rect => {
  const minX = workArea.x + DOCK_EDGE_MARGIN;
  const maxX = workArea.x + workArea.width - DOCK_WINDOW_WIDTH - DOCK_EDGE_MARGIN;
  const minY = workArea.y + DOCK_V_MARGIN;
  const maxY = workArea.y + workArea.height - DOCK_WINDOW_HEIGHT - DOCK_V_MARGIN;
  return {
    x: bandToPixel(minX, maxX, clampAnchorAxis(anchor.nx, DEFAULT_DOCK_ANCHOR.nx)),
    y: bandToPixel(minY, maxY, clampAnchorAxis(anchor.ny, DEFAULT_DOCK_ANCHOR.ny)),
    width: DOCK_WINDOW_WIDTH,
    height: DOCK_WINDOW_HEIGHT,
  };
};

/** Gap between the pill's visual edge and the float's default position. */
export const FLOAT_DOCK_GAP = 8;
/**
 * The pill's visual zone inside the (mostly transparent) dock window: the
 * idle pill + hover grip hug the window's snapped edge within ~this many px.
 */
const DOCK_PILL_ZONE = 120;

/**
 * The floating note's DEFAULT rect (no persisted `floatNoteBounds` for this
 * display): beside the pill, on its inner side — left of a right-docked pill,
 * right of a left-docked one — vertically centred on the pill and clamped to
 * the work area (so a pill near the top/bottom edge pushes the float below/
 * above it rather than off-screen).
 */
export const defaultFloatRectNearDock = (workArea: Rect, anchor: DockAnchor): Rect => {
  const dock = computeDockBounds(workArea, anchor);
  const width = clampSize(FLOAT_DEFAULT_WIDTH, FLOAT_MIN_WIDTH, workArea.width);
  const height = clampSize(FLOAT_DEFAULT_HEIGHT, FLOAT_MIN_HEIGHT, workArea.height);
  const onLeftEdge = clampAnchorAxis(anchor.nx, DEFAULT_DOCK_ANCHOR.nx) < 0.5;
  const rawX = onLeftEdge
    ? dock.x + DOCK_PILL_ZONE + FLOAT_DOCK_GAP
    : dock.x + dock.width - DOCK_PILL_ZONE - FLOAT_DOCK_GAP - width;
  const rawY = dock.y + dock.height / 2 - height / 2;
  const minX = workArea.x;
  const maxX = workArea.x + workArea.width - width;
  const minY = workArea.y;
  const maxY = workArea.y + workArea.height - height;
  return {
    x: Math.round(Math.min(Math.max(rawX, minX), maxX)),
    y: Math.round(Math.min(Math.max(rawY, minY), maxY)),
    width,
    height,
  };
};

/** A 2-axis drag sample: pointer screen position + the grab's window offset. */
export interface DockDragSample {
  readonly screenX: number;
  readonly screenY: number;
  readonly pointerOffsetX: number;
  readonly pointerOffsetY: number;
}

/**
 * A drag sample → the anchor to apply/persist. The window's new origin is
 * `(screenX - pointerOffsetX, screenY - pointerOffsetY)` (the grab point held
 * under the pointer), clamped into the bands, then projected back to fractions.
 * Horizontally, within `DOCK_SNAP_PX` of a band edge snaps flush to it (the
 * magnetic left/right edge pull); vertically there is no snap. A collapsed band
 * pins to 1 (right/bottom — legacy `dragToNormalizedY` parity: renders at the
 * min margin while collapsed, restores to the far edge when the band returns).
 */
export const dragToDockAnchor = (workArea: Rect, sample: DockDragSample): DockAnchor => {
  const minX = workArea.x + DOCK_EDGE_MARGIN;
  const maxX = workArea.x + workArea.width - DOCK_WINDOW_WIDTH - DOCK_EDGE_MARGIN;
  const minY = workArea.y + DOCK_V_MARGIN;
  const maxY = workArea.y + workArea.height - DOCK_WINDOW_HEIGHT - DOCK_V_MARGIN;

  let nx = 1;
  if (maxX > minX) {
    let x = Math.min(maxX, Math.max(minX, Math.round(sample.screenX - sample.pointerOffsetX)));
    if (x - minX <= DOCK_SNAP_PX) x = minX;
    else if (maxX - x <= DOCK_SNAP_PX) x = maxX;
    nx = clampAnchorAxis((x - minX) / (maxX - minX), 1);
  }

  let ny = 1;
  if (maxY > minY) {
    const y = Math.min(maxY, Math.max(minY, Math.round(sample.screenY - sample.pointerOffsetY)));
    ny = clampAnchorAxis((y - minY) / (maxY - minY), 1);
  }

  return { nx, ny };
};

/** The minimal display shape the pure resolution helpers need. */
export interface DisplayLike {
  readonly id: number | string;
  readonly workArea: Rect;
}

/**
 * The display the dock should open on: the saved `dockDisplayId` if that display
 * is still connected, else the primary (display-vanish fallback — an unplugged
 * monitor never strands the dock off-screen).
 */
export const resolveDockDisplay = <D extends DisplayLike>(
  displays: readonly D[],
  primary: D,
  savedDisplayId: string | null
): D =>
  (savedDisplayId !== null ? displays.find(d => String(d.id) === savedDisplayId) : undefined) ??
  primary;

/**
 * The anchor for a display: its saved per-display anchor if present (clamped),
 * else the legacy-seeded default — right edge (`nx: 1`) at the legacy
 * `widgetNormalizedY` row. That read-side fallback performs the migration: a
 * user who never drags keeps their old spot on every display; the first drag on
 * a display writes its `dockAnchors` entry and this fallback stops applying.
 */
export const anchorForDisplay = (
  anchors: Readonly<Record<string, Partial<DockAnchor>>>,
  displayId: string,
  legacyNormalizedY: number
): DockAnchor => {
  const saved = anchors[displayId];
  return saved !== undefined
    ? clampDockAnchor(saved)
    : { nx: 1, ny: clampAnchorAxis(legacyNormalizedY, DEFAULT_DOCK_ANCHOR.ny) };
};

/**
 * Notify window bounds within a display work area: pinned to the
 * top-right corner (the card stack anchors there; the panel is click-through
 * outside cards, so its fixed footprint is invisible + inert). The window
 * shifts INSET px toward the corner so the renderer's shadow padding cancels
 * out — the cards' visual gap from the screen corner stays NOTIFY_MARGIN.
 */
export const computeNotifyBounds = (workArea: Rect): Rect => ({
  x: workArea.x + workArea.width - NOTIFY_WINDOW_WIDTH - NOTIFY_MARGIN + NOTIFY_CARD_INSET,
  y: workArea.y + NOTIFY_MARGIN - NOTIFY_CARD_INSET,
  width: NOTIFY_WINDOW_WIDTH,
  height: NOTIFY_WINDOW_HEIGHT,
});

const clampSize = (value: number, min: number, max: number): number =>
  Math.round(Math.min(Math.max(value, min), Math.max(min, max)));

/**
 * Persisted normalized float bounds → window bounds within a work area. No
 * saved bounds (undefined / malformed) → the default size centred. Size clamps
 * into `[FLOAT_MIN, workArea]`; position bands span the full work area (no
 * margins — the note is a real window, flush edges are fine). Inverse of
 * `rectToFloatBounds` on the same work area (± rounding).
 */
export const floatBoundsToRect = (
  workArea: Rect,
  saved: Partial<FloatNormBounds> | undefined
): Rect => {
  const width = clampSize(
    Number.isFinite(saved?.nw ?? Number.NaN)
      ? (saved as FloatNormBounds).nw * workArea.width
      : FLOAT_DEFAULT_WIDTH,
    FLOAT_MIN_WIDTH,
    workArea.width
  );
  const height = clampSize(
    Number.isFinite(saved?.nh ?? Number.NaN)
      ? (saved as FloatNormBounds).nh * workArea.height
      : FLOAT_DEFAULT_HEIGHT,
    FLOAT_MIN_HEIGHT,
    workArea.height
  );
  const minX = workArea.x;
  const maxX = workArea.x + workArea.width - width;
  const minY = workArea.y;
  const maxY = workArea.y + workArea.height - height;
  return {
    x: bandToPixel(minX, maxX, clampAnchorAxis(saved?.nx ?? Number.NaN, 0.5)),
    y: bandToPixel(minY, maxY, clampAnchorAxis(saved?.ny ?? Number.NaN, 0.5)),
    width,
    height,
  };
};

/**
 * Window bounds → the normalized float bounds to persist. Position projects
 * across the full-work-area band (collapsed band → 0), size as a work-area
 * fraction (clamped to 1 — a window larger than the work area persists as
 * full-size).
 */
export const rectToFloatBounds = (workArea: Rect, rect: Rect): FloatNormBounds => {
  const maxX = workArea.x + workArea.width - rect.width;
  const maxY = workArea.y + workArea.height - rect.height;
  return {
    nx: maxX <= workArea.x ? 0 : clampAnchorAxis((rect.x - workArea.x) / (maxX - workArea.x), 0),
    ny: maxY <= workArea.y ? 0 : clampAnchorAxis((rect.y - workArea.y) / (maxY - workArea.y), 0),
    nw: clampAnchorAxis(rect.width / workArea.width, 1),
    nh: clampAnchorAxis(rect.height / workArea.height, 1),
  };
};
