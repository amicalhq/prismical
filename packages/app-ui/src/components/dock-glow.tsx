'use client';

import * as React from 'react';
import { consumeFreshNote } from '@prismical/app-client';

/**
 * Arrival glow for the dock: a prism-colored light band that travels the rim of a dock pill, led
 * by a crisp line with a soft glow and bloom trailing inward behind it. It plays briefly when the
 * app loads and when a new note opens, to draw the eye to the dock.
 *
 * The band is a dash on an SVG stroke of a rounded rect, normalized with pathLength so it travels
 * at constant speed and bends around the corners. Each layer is drawn at a different width and
 * blur, with the soft layers' heads pulled back behind the leading tip. Render it as the FIRST
 * child of a `relative overflow-hidden` pill whose content is positioned above it and does not
 * paint an opaque background.
 *
 * With a `frame` (the dock row), every glowing pill strokes the SAME rounded rect spanning the
 * whole row, shifted to its own position and clipped to its own shape, on one shared clock — so a
 * single band runs across the pills, crossing the gap between them, instead of one per pill.
 */

// Spread across the loop left to right, so the band shifts hue as it travels. The palette lives in
// tokens.css (--prism-hue-*), shared with the brand splash halo.
const PRISM = [1, 2, 3, 4, 5, 6].map(n => `var(--prism-hue-${n})`);
/** Per scope: seconds per lap and how long the glow shows. The whole-dock app-load glow takes one
 * unhurried lap; a new note's Record-only glow is a quicker, shorter flourish. */
const TIMING = {
  dock: { lapS: 3, durationMs: 3000 },
  record: { lapS: 1.2, durationMs: 2400 },
} as const;
const FADE_MS = 450;
/** Fraction of the perimeter the band covers. */
const ARC = 0.34;
const LINE = 2;
const BLOOM = 10;

type Geometry = {
  /** The pill's own box, px. */
  w: number;
  h: number;
  /** The loop the band travels, in the pill's coordinates. */
  loopX: number;
  loopW: number;
};

export function DockGlow({
  active,
  radius,
  frame,
}: {
  active: boolean;
  radius: number;
  /** Share one loop across everything inside this element (the dock row). */
  frame?: React.RefObject<HTMLElement | null>;
}) {
  const id = `dock-glow-${React.useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const ref = React.useRef<HTMLSpanElement>(null);
  const [mounted, setMounted] = React.useState(active);
  const [geo, setGeo] = React.useState<Geometry | null>(null);
  // The glow this pill is showing — its clock, speed and loop — captured when it lights up and
  // frozen after, so a pill still fading out keeps its own band when a new glow starts elsewhere.
  const [shown, setShown] = React.useState(() => ({ startedAt: glowStartedAt, scope: glowScope, frame }));
  if (active && (shown.startedAt !== glowStartedAt || shown.frame !== frame)) {
    setShown({ startedAt: glowStartedAt, scope: glowScope, frame });
  }
  const loopFrame = shown.frame;

  // Stay mounted through the fade-out, then drop the SVG and its observer entirely.
  React.useEffect(() => {
    if (active) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), FADE_MS);
    return () => clearTimeout(timer);
  }, [active]);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const row = loopFrame?.current ?? null;
    const measure = () => {
      const w = Math.max(1, el.clientWidth);
      const h = Math.max(1, el.clientHeight);
      if (!row) {
        setGeo({ w, h, loopX: 0, loopW: w });
        return;
      }
      // The pills' 1px borders sit outside this padding box; inset the row by the same amount so
      // the loop meets each pill's rim where its own glow would.
      const own = el.getBoundingClientRect();
      const span = row.getBoundingClientRect();
      const loopX = span.left + 1 - own.left;
      setGeo({ w, h, loopX, loopW: Math.max(w, span.width - 2) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (row) observer.observe(row);
    return () => observer.disconnect();
  }, [mounted, loopFrame]);

  // Seconds into the current glow when this pill's band first paints. Every pill offsets its
  // animation by it, so bands mounted at different moments still run on the one shared clock.
  // Keyed to the glow's start and to the first measurement only: re-deriving it on a resize would
  // restart the running animation's timeline.
  const hasGeo = geo !== null;
  const startedAt = shown.startedAt;
  const elapsed = React.useMemo(
    () => (hasGeo && startedAt ? (performance.now() - startedAt) / 1000 : 0),
    [hasGeo, startedAt],
  );

  if (!mounted) return null;

  const lapS = TIMING[shown.scope].lapS;
  const layers = geo ? glowLayers(geo.loopW, geo.h, radius, lapS) : [];
  return (
    <span
      ref={ref}
      aria-hidden
      className="dock-glow pointer-events-none absolute inset-0 overflow-hidden"
      data-fading={active ? undefined : ''}
      style={{ borderRadius: 'inherit' }}
    >
      {geo && (
        <svg
          key={startedAt}
          width="100%"
          height="100%"
          viewBox={`0 0 ${geo.w} ${geo.h}`}
          preserveAspectRatio="none"
          className="block"
        >
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
              {PRISM.map((color, index) => (
                // A CSS var only resolves through `style`, not the stop-color presentation attribute.
                <stop key={color} offset={`${(index / (PRISM.length - 1)) * 100}%`} style={{ stopColor: color }} />
              ))}
            </linearGradient>
            {/* SVG-native blur: WebKit ignores CSS filters on individual SVG elements. The region
                is widened well past the stroke so the blur never clips at the filter bounds. */}
            {layers.map(layer => (
              <filter key={layer.key} id={`${id}-${layer.key}`} x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation={layer.blur} />
              </filter>
            ))}
          </defs>
          {layers.map(layer => (
            <rect
              key={layer.key}
              x={geo.loopX}
              y={0}
              width={geo.loopW}
              height={geo.h}
              rx={Math.min(radius, geo.loopW / 2, geo.h / 2)}
              pathLength={100}
              fill="none"
              stroke={`url(#${id})`}
              strokeWidth={layer.width}
              strokeLinecap="round"
              strokeDasharray={`${layer.len} ${100 - layer.len}`}
              filter={`url(#${id}-${layer.key})`}
              style={{
                opacity: layer.opacity,
                // A negative delay places each layer's tip `back` units behind the shared tip.
                animation: `dock-glow-lap ${lapS}s linear ${layer.delay - elapsed}s infinite`,
              }}
            />
          ))}
        </svg>
      )}
    </span>
  );
}

function glowLayers(w: number, h: number, radius: number, lapS: number) {
  const r = Math.min(radius, w / 2, h / 2);
  const perimeter = Math.max(1, 2 * (w + h) - 8 * r + 2 * Math.PI * r);
  const band = ARC * 100;
  const layer = (key: string, width: number, blur: number, opacity: number, len: number, backPx: number) => {
    // The keyframes run the dash offset 0 → -100, which puts the dash at [p, p+len] for lap
    // progress p. Delaying by (len + back) units puts the tip `back` units behind p; subtracting a
    // full lap keeps the delay negative so every layer is already moving on the first frame.
    const back = (backPx * 100) / perimeter;
    return { key, width, blur, opacity, len, delay: lapS * ((((len + back) / 100) % 1) - 1) };
  };
  return [
    // Wide bloom bleeding inward (the outer half is clipped by the pill).
    layer('bloom', BLOOM * 2, 9, 0.35, band * 0.9, BLOOM + 12),
    // Tight glow.
    layer('glow', LINE * 3.2, 4, 0.8, band * 0.95, 8),
    // Crisp leading line.
    layer('line', LINE, 0.5, 1, band, 0),
  ];
}

/** Module-scoped so the boot glow plays once per app load, not on every dock remount. */
let bootGlowPlayed = false;
/**
 * When the current glow ends (epoch ms). Module-scoped because the dock remounts during startup
 * (its recording client arrives after the first render), and a remount mid-glow must pick the
 * glow back up rather than drop it.
 */
let glowUntil = 0;
/** When the current glow started (performance.now() ms); the shared clock every pill runs on. */
let glowStartedAt = 0;
/** Which pills the current glow covers: the whole dock on app load, only Record for a new note. */
let glowScope: DockGlowScope = 'dock';
/** A glow requested while the page was hidden, played when it next becomes visible. */
let pendingScope: DockGlowScope | null = null;

export type DockGlowScope = 'dock' | 'record';

/**
 * Whether the dock's arrival glow is showing, and on which pills: the whole dock once on app load,
 * and only the Record pill when a newly created note opens. `stop` ends it early (the dock calls it
 * on the user's first interaction). A disabled dock never glows and leaves new notes unconsumed.
 */
export function useDockArrivalGlow(noteId: string | null, enabled = true) {
  // Resume a glow a previous mount of the dock started.
  const [run, setRun] = React.useState(() => (enabled && glowUntil > Date.now() ? 1 : 0));
  const [active, setActive] = React.useState(false);

  const play = React.useCallback((scope: DockGlowScope) => {
    if (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }
    // A glow nobody can see is wasted — a window opened in the background waits until it shows.
    if (typeof document !== 'undefined' && document.hidden) {
      pendingScope = scope;
      return;
    }
    glowUntil = Date.now() + TIMING[scope].durationMs;
    glowStartedAt = performance.now();
    glowScope = scope;
    setRun(n => n + 1);
  }, []);

  React.useEffect(() => {
    if (!enabled || bootGlowPlayed) return;
    bootGlowPlayed = true;
    play('dock');
  }, [enabled, play]);

  React.useEffect(() => {
    if (enabled && noteId && consumeFreshNote(noteId)) play('record');
  }, [enabled, noteId, play]);

  React.useEffect(() => {
    if (!enabled) return;
    const onVisibility = () => {
      if (document.hidden || !pendingScope) return;
      const scope = pendingScope;
      pendingScope = null;
      play(scope);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [enabled, play]);

  React.useEffect(() => {
    const remaining = glowUntil - Date.now();
    if (!run || remaining <= 0) return;
    setActive(true);
    const timer = setTimeout(() => setActive(false), remaining);
    return () => clearTimeout(timer);
  }, [run]);

  const stop = React.useCallback(() => {
    if (!enabled) return;
    glowUntil = 0;
    pendingScope = null;
    setActive(false);
  }, [enabled]);
  return { active, scope: glowScope, stop };
}
