/**
 * Pure window/navigation/CSP/permission policy. No Electron import
 * — everything here is table-driven unit-testable.
 */
import path from 'node:path';

export const APP_SCHEME = 'prismical-app';
export const APP_SCHEME_HOST = 'bundle';
export const APP_INDEX_URL = `${APP_SCHEME}://${APP_SCHEME_HOST}/index.html`;
/**
 * The floating widget's document. Same privileged `bundle` host as the
 * main window — the multi-page renderer build emits widget.html alongside
 * index.html, so protocol.handle + the CSP membrane serve it unchanged.
 */
export const WIDGET_INDEX_URL = `${APP_SCHEME}://${APP_SCHEME_HOST}/widget.html`;

/** The notification layer's document — same privileged host. */
export const NOTIFY_INDEX_URL = `${APP_SCHEME}://${APP_SCHEME_HOST}/notify.html`;

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Protocol allowlist for handing URLs to the OS browser. Unparseable or
 * off-list URLs return false
 * — the caller denies.
 */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * will-navigate confinement: in-window navigation may never leave the app
 * origin — the dev-server origin under `forge start`, the privileged custom
 * scheme otherwise.
 */
export function isAppNavigationUrl(url: string, devServerUrl: string | null): boolean {
  try {
    const parsed = new URL(url);
    if (devServerUrl !== null) {
      return parsed.origin === new URL(devServerUrl).origin;
    }
    // Custom schemes have a 'null' origin in WHATWG URL; compare parts.
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_SCHEME_HOST;
  } catch {
    return false;
  }
}

/**
 * The floor for both the opening size and the resize limit.
 *
 * Width: below app-ui's md breakpoint (768) the sidebar collapses into a mobile
 * sheet whose top rows sit under the traffic lights / header drag band, so the
 * frameless window must never go under 800.
 *
 * Height: 480 is the point below which the note view's header + editor + dock
 * stop co-existing without the editor becoming a slit.
 *
 * NOTE this floor deliberately WINS over the work area: on a display shorter
 * than 480 (or narrower than 800) the window opens larger than the screen and
 * is clipped, because rendering the shell below its breakpoints is the worse
 * failure. Raising either constant widens the range where that happens.
 */
export const MAIN_WINDOW_MIN_WIDTH = 800;
export const MAIN_WINDOW_MIN_HEIGHT = 480;

/**
 * Upper bound on the opening size. Past this a fresh window stops feeling like
 * a document app and starts feeling like a maximised one; the user can still
 * resize or zoom beyond it.
 */
export const MAIN_WINDOW_MAX_WIDTH = 1440;
export const MAIN_WINDOW_MAX_HEIGHT = 940;

/**
 * The default opening size of the main window, derived from the display rather
 * than hard-coded. The old fixed 1100x720 opened small on every modern display
 * and cramped the note view's two panes; a bigger fixed size would instead
 * overflow a 13" laptop, whose work area is barely taller than 800px. Scaling
 * with a cap and a floor satisfies both: roomy on a large monitor, still fully
 * on-screen on a small one.
 *
 * Takes the work area (not the full display bounds) so the macOS menu bar and
 * the dock/taskbar are already excluded.
 */
export function computeMainWindowSize(workArea: {
  readonly width: number;
  readonly height: number;
}): { readonly width: number; readonly height: number } {
  // Total by construction: `Math.max(min, Math.min(max, NaN))` is NaN, which
  // would reach `new BrowserWindow({ width: NaN })`. No caller can produce one
  // today (a disconnecting display reports 0x0, which floors correctly), but
  // this is the pure policy layer — it should not depend on that staying true.
  //
  // Guarded on isNaN rather than isFinite deliberately: ±Infinity has a correct
  // answer here (the cap / the floor) and Math.min/max already give it. Only
  // NaN — which is also what `undefined * 0.9` yields — has none, so it alone
  // falls back to the floor.
  const clamp = (value: number, min: number, max: number): number =>
    Number.isNaN(value) ? min : Math.max(min, Math.min(max, value));
  return {
    width: clamp(
      Math.round(workArea.width * 0.85),
      MAIN_WINDOW_MIN_WIDTH,
      MAIN_WINDOW_MAX_WIDTH
    ),
    height: clamp(
      Math.round(workArea.height * 0.9),
      MAIN_WINDOW_MIN_HEIGHT,
      MAIN_WINDOW_MAX_HEIGHT
    ),
  };
}

export type WindowKind = 'main' | 'widget' | 'notify' | 'float-note';

/**
 * setPermissionRequestHandler allowlist: media, for the APP windows only (main
 * + the floating note, which runs the same renderer bundle);
 * nothing else, ever. The sanitized panels (widget/notify) stay denied.
 */
export function isPermissionAllowed(permission: string, senderKind: WindowKind | 'unknown'): boolean {
  return permission === 'media' && (senderKind === 'main' || senderKind === 'float-note');
}

export interface CspOptions {
  /** Present only when cloud-mode support is configured. */
  readonly gleapNonce?: string;
  readonly devServerUrl: string | null;
  readonly noteWsUrl: string;
  readonly analyticsKey: string | null;
  /** Analytics ingestion origin; only added when an analyticsKey is configured. */
  readonly analyticsOrigin?: string | null;
}

const originOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
};

/**
 * Strict per-renderer CSP: connect-src reduces to self + the note WSS +
 * analytics ingestion (when configured) — core is unreachable from the
 * renderer by construction. Dev adds the Vite HMR websocket ('self'
 * does not cover ws: scheme upgrades in Chromium).
 */
export function buildCsp(options: CspOptions): string {
  const connect = ["'self'"];
  const gleap = options.gleapNonce ? ' https://*.gleap.io' : '';
  if (gleap) connect.push('https://*.gleap.io', 'wss://*.gleap.io');
  const noteOrigin = originOf(options.noteWsUrl);
  if (noteOrigin !== null) connect.push(noteOrigin);
  if (options.analyticsKey !== null && options.analyticsOrigin) {
    connect.push(options.analyticsOrigin);
  }
  if (options.devServerUrl !== null) {
    const dev = originOf(options.devServerUrl);
    if (dev !== null) connect.push(dev.replace(/^http/, 'ws'));
  }

  const directives = [
    "default-src 'self'",
    // Dev only: @vitejs/plugin-react injects an inline react-refresh preamble
    // into index.html; without 'unsafe-inline' the preamble is CSP-blocked and
    // every transformed module throws ("can't detect preamble") — white screen.
    // Packaged builds permit inline scripts only with the configured support nonce.
    (options.devServerUrl !== null
      ? "script-src 'self' 'unsafe-inline'"
      : `script-src 'self'${options.gleapNonce ? ` 'nonce-${options.gleapNonce}'` : ''}`) + gleap,
    // Inline styles: vite dev injects <style>, and the placeholder/app shells
    // use style attributes.
    "style-src 'self' 'unsafe-inline'" + gleap,
    "img-src 'self' data:" + (gleap ? `${gleap} blob:` : ''),
    "font-src 'self' data:" + gleap,
    ...(gleap ? [`frame-src 'self'${gleap}`, `media-src 'self'${gleap} blob:`] : []),
    `connect-src ${connect.join(' ')}`,
    // rrweb (session replay) may spawn a web worker from a blob: URL; allow it
    // only when analytics is configured (else default-src 'self' keeps blocking).
    ...(options.analyticsKey !== null && options.analyticsOrigin ? ["worker-src 'self' blob:"] : []),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ];
  return directives.join('; ');
}

/**
 * Maps a custom-scheme request pathname onto the built renderer directory.
 * Root-absolute asset paths (e.g. /audio-recorder-processor.js) must work —
 * that is the point of the rooted scheme. Returns null for
 * path-traversal attempts. Purely computes the candidate path; existence is
 * the caller's concern.
 */
export function resolveRendererAssetPath(rendererDir: string, urlPathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPathname);
  } catch {
    return null;
  }
  const relative = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolved = path.normalize(path.join(rendererDir, relative));
  const root = path.normalize(rendererDir + path.sep);
  if (!resolved.startsWith(root)) return null;
  return resolved;
}
