// Shared chrome for the bottom dock cluster.
// The dock is TWO morphing units — Record and Ask — plus transient pills (skill
// diff bar, away/new-note faces). One source of truth for the surface treatment
// so the dock reads as a single element as it morphs per page and per state.
//
// v3 replaced the black-glass pills + detached glass panels with OPAQUE raised
// surfaces (tokens.css --dock-*). Opaque on purpose: no backdrop-filter means
// none of the backdrop-root constraints that shaped the old chrome
// apply — ancestors may fade/clip freely.

// Width/height morph curve shared by the units and their collapsing siblings.
// One curve so the pill→panel expansion and the sibling's collapse read as a
// single movement. The fade/scale legs run FASTER on a plain ease-out so a
// collapsing sibling is gone before the size morph lands.
export const DOCK_MORPH_TRANSITION =
  '[transition:width_240ms_cubic-bezier(0.32,0.72,0.28,1),height_240ms_cubic-bezier(0.32,0.72,0.28,1),margin_240ms_cubic-bezier(0.32,0.72,0.28,1),opacity_180ms_ease-out,translate_180ms_ease-out,scale_180ms_ease-out]';

/** Base card treatment every dock surface shares: raised opaque surface,
 * hairline border, layered shadow, clipped corners. */
export const DOCK_SURFACE_CHROME =
  'relative overflow-hidden rounded-[14px] border border-dock-line bg-dock-surface shadow-(--dock-shadow)';

// A standalone 42px pill built on the surface chrome (skill diff bar, away
// pill, new-note pill — units carry the same treatment via DockUnit).
// `dock-pill` is a marker for tokens.css rules (.dock-slot-dimmed dims pills
// via opacity now that they are opaque).
export const DOCK_PILL_CHROME = `dock-pill group ${DOCK_SURFACE_CHROME} flex h-[42px] select-none items-center text-dock-ink ${DOCK_MORPH_TRANSITION}`;

/** The shared 28px control atom (Beautiful-UI scale: 28px box, radius 8). */
export const DOCK_CTL =
  'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-dock-ink-3 transition-[background-color,color,scale] duration-150 hover:bg-dock-hover hover:text-dock-ink active:scale-[0.94] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent';

/** The control atom one ink step brighter for the panel action cluster. Full literal, not a
 * .replace() derivation, so Tailwind's scanner sees every class. */
export const DOCK_CTL_INK2 =
  'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-dock-ink-2 transition-[background-color,color,scale] duration-150 hover:bg-dock-hover hover:text-dock-ink active:scale-[0.94] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent';

/** Filled primary variant of the control atom (send buttons). */
export const DOCK_CTL_PRIMARY =
  'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-primary text-primary-foreground transition-[opacity,scale] duration-150 hover:opacity-90 active:scale-[0.94] disabled:cursor-default disabled:opacity-35';

/** Dock-token restyle of the shared MessageScrollerButton, right-anchored on
 * the raised surface; the app default is centered on app
 * tokens. */
export const DOCK_SCROLL_BUTTON =
  'inset-s-auto right-3 translate-x-0 rtl:translate-x-0 border-dock-line bg-dock-surface text-dock-ink-2 shadow-(--dock-shadow-raised) hover:bg-dock-hover hover:text-dock-ink';

/** Floating menu surface anchored to a dock control (mic menu, history,
 * slash/plus menus): raised dock card, 10px radius, 4px inner gutter. */
export const DOCK_MENU_SURFACE =
  'rounded-[10px] border-dock-line bg-dock-surface p-1 shadow-(--dock-shadow-raised)';

/** The hover-revealed floating action cluster inside a panel face: ONE bordered
 * container, top-right, elevated a step off the surface (ink-tinted fill +
 * button shadow + drop) so it stays legible over panel content. Reveal is
 * driven by the panel face's group (`group/panel`). */
export const DOCK_PANEL_ACTIONS_CHROME =
  'absolute right-2.5 top-2.5 z-30 flex items-center gap-0.5 rounded-[10px] border border-dock-line bg-[color-mix(in_srgb,var(--dock-ink)_4%,var(--dock-surface))] p-0.5 shadow-[var(--dock-shadow-btn),0_4px_14px_rgba(0,0,0,0.16)] opacity-0 transition-opacity duration-150 pointer-events-none group-hover/panel:pointer-events-auto group-hover/panel:opacity-100 group-focus-within/panel:pointer-events-auto group-focus-within/panel:opacity-100';
