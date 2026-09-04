'use client';

import * as React from 'react';
import { DOCK_MORPH_TRANSITION, DOCK_SURFACE_CHROME } from './dock-chrome';

/**
 * One morphing dock unit: a single raised surface that is a 42px pill
 * at rest and expands IN PLACE into its panel — width and height animate on the
 * unit itself while the two faces (pill / panel) crossfade inside it. The dock
 * row bottom-aligns its children, so an expanding unit grows upward.
 *
 * The dock design uses the `.unit` / `.face` rules described below.
 *
 * Faces stay MOUNTED through the morph (the Ask conversation must survive
 * collapse), so the hidden face is inert + aria-hidden rather than unmounted.
 */
export function DockUnit({
  expanded,
  collapsed,
  pillWidth,
  panelWidth,
  panelHeight,
  pill,
  panel,
  className = '',
  compact = false,
}: {
  /** This unit is showing its panel face. */
  expanded: boolean;
  /** A SIBLING unit is expanded — this unit leaves the row (width 0, faded,
   * margin swallowing the row gap) so the panel reads as replacing the whole
   * dock rather than pushing its neighbour aside. */
  collapsed: boolean;
  /** Pill-face width — px number, or any CSS width expression (min() ok).
   * Animates when the pill's own state changes width (e.g. idle → recording
   * controls). */
  pillWidth: number | string;
  /** Expanded panel size — any CSS width/height expression (min()/clamp() ok). */
  panelWidth: string;
  panelHeight: string;
  pill: React.ReactNode;
  panel: React.ReactNode;
  className?: string;
  /** Narrow-surface scale for the floating note window: 36px pills on a 12px
   * radius instead of 42px/14px. */
  compact?: boolean;
}) {
  const width = collapsed
    ? '0px'
    : expanded
      ? panelWidth
      : typeof pillWidth === 'number'
        ? `${pillWidth}px`
        : pillWidth;
  const height = expanded && !collapsed ? panelHeight : compact ? '36px' : '42px';
  return (
    <div
      className={`${DOCK_SURFACE_CHROME} ${DOCK_MORPH_TRANSITION} ${
        collapsed ? 'pointer-events-none -ml-2 translate-y-1.5 scale-[0.92] opacity-0' : ''
      } ${className}`}
      // borderWidth inline (not a border-0 class): it must beat the chrome's `border`
      // utility regardless of Tailwind's emit order. Same for the compact radius
      // vs the chrome's rounded-[14px].
      style={{
        width,
        height,
        ...(compact ? { borderRadius: 12 } : {}),
        ...(collapsed ? { borderWidth: 0 } : {}),
      }}
      {...(collapsed ? { inert: true } : {})}
      aria-hidden={collapsed}
    >
      {/* Pill face */}
      <div
        className={`absolute inset-0 transition-opacity duration-[120ms] ease-out ${
          expanded ? 'pointer-events-none opacity-0' : 'opacity-100 delay-100'
        }`}
        {...(expanded ? { inert: true } : {})}
        aria-hidden={expanded}
      >
        {pill}
      </div>
      {/* Panel face — group/panel drives the hover-revealed action cluster
          (DOCK_PANEL_ACTIONS_CHROME). */}
      <div
        className={`group/panel absolute inset-0 flex flex-col transition-opacity duration-[120ms] ease-out ${
          expanded ? 'opacity-100 delay-100' : 'pointer-events-none opacity-0'
        }`}
        {...(expanded ? {} : { inert: true })}
        aria-hidden={!expanded}
      >
        {panel}
      </div>
    </div>
  );
}

/**
 * Row-mate collapse wrapper for NON-unit dock elements (the skill slot, the
 * transient pills): applies the same leave-the-row treatment DockUnit uses for
 * its `collapsed` state, so everything in the row vanishes in one movement when
 * a unit expands.
 *
 * The width leg is a `grid-template-columns: 1fr → 0fr` interpolation — unlike
 * `width: auto → 0`, fr tracks ARE animatable, so intrinsic-width content
 * glides shut in the same 240ms the units use instead of snapping its layout
 * box in one frame (the inner wrapper's min-width:0 + overflow let the track
 * actually squeeze it).
 */
export function DockRowmate({
  collapsed,
  children,
}: {
  collapsed: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`grid [transition:grid-template-columns_240ms_cubic-bezier(0.32,0.72,0.28,1),margin_240ms_cubic-bezier(0.32,0.72,0.28,1),opacity_180ms_ease-out,translate_180ms_ease-out,scale_180ms_ease-out] ${
        collapsed
          ? 'pointer-events-none -ml-2 translate-y-1.5 scale-[0.92] opacity-0 [grid-template-columns:0fr]'
          : '[grid-template-columns:1fr]'
      }`}
      {...(collapsed ? { inert: true } : {})}
      aria-hidden={collapsed}
    >
      {/* At rest the clip margin leaves headroom so the pill's drop shadow isn't
          shaved (the fr track fits the content exactly); while collapsed the
          margin drops so nothing paints outside the closed track. */}
      <div
        className={`min-w-0 overflow-clip ${
          collapsed ? '[overflow-clip-margin:0px]' : '[overflow-clip-margin:48px]'
        }`}
      >
        {children}
      </div>
    </div>
  );
}
