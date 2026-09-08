import { describe, expect, it } from 'vitest';
import {
  APP_INDEX_URL,
  MAIN_WINDOW_MAX_HEIGHT,
  MAIN_WINDOW_MAX_WIDTH,
  MAIN_WINDOW_MIN_HEIGHT,
  MAIN_WINDOW_MIN_WIDTH,
  buildCsp,
  computeMainWindowSize,
  isAllowedExternalUrl,
  isAppNavigationUrl,
  isPermissionAllowed,
  resolveRendererAssetPath,
} from '../../src/main/domains/windows/policy';

describe('isAllowedExternalUrl', () => {
  it('allows the browser-bound protocols', () => {
    expect(isAllowedExternalUrl('https://prismical.ai/docs')).toBe(true);
    expect(isAllowedExternalUrl('http://example.com')).toBe(true);
    expect(isAllowedExternalUrl('mailto:support@prismical.ai')).toBe(true);
    expect(isAllowedExternalUrl('tel:+15550100')).toBe(true);
  });

  it('denies everything else', () => {
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternalUrl('prismical://oauth/callback')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('chrome://settings')).toBe(false);
    expect(isAllowedExternalUrl('not a url')).toBe(false);
    expect(isAllowedExternalUrl('')).toBe(false);
  });
});

describe('isAppNavigationUrl', () => {
  it('packaged/bundle mode: only the custom scheme origin', () => {
    expect(isAppNavigationUrl(APP_INDEX_URL, null)).toBe(true);
    expect(isAppNavigationUrl('prismical-app://bundle/notes', null)).toBe(true);
    expect(isAppNavigationUrl('prismical-app://evil/index.html', null)).toBe(false);
    expect(isAppNavigationUrl('https://example.com', null)).toBe(false);
    expect(isAppNavigationUrl('file:///etc/passwd', null)).toBe(false);
    expect(isAppNavigationUrl('garbage', null)).toBe(false);
  });

  it('dev mode: only the dev-server origin', () => {
    const dev = 'http://localhost:5173';
    expect(isAppNavigationUrl('http://localhost:5173/index.html', dev)).toBe(true);
    expect(isAppNavigationUrl('http://localhost:9999/index.html', dev)).toBe(false);
    expect(isAppNavigationUrl(APP_INDEX_URL, dev)).toBe(false);
  });
});

describe('isPermissionAllowed', () => {
  it('media on the main window only', () => {
    expect(isPermissionAllowed('media', 'main')).toBe(true);
    expect(isPermissionAllowed('media', 'widget')).toBe(false);
    expect(isPermissionAllowed('media', 'unknown')).toBe(false);
    expect(isPermissionAllowed('geolocation', 'main')).toBe(false);
    expect(isPermissionAllowed('notifications', 'main')).toBe(false);
    expect(isPermissionAllowed('clipboard-read', 'main')).toBe(false);
  });
});

describe('buildCsp', () => {
  it('allows Gleap resources with a nonce, without permitting arbitrary inline scripts', () => {
    const csp = buildCsp({ devServerUrl: null, noteWsUrl: 'wss://note.test', analyticsKey: null, gleapNonce: 'test-nonce' });
    expect(csp).toContain("script-src 'self' 'nonce-test-nonce' https://*.gleap.io;");
    expect(csp).toContain("connect-src 'self' https://*.gleap.io wss://*.gleap.io");
    expect(csp).toContain("frame-src 'self' https://*.gleap.io;");
  });
  it('keeps Vite inline scripts working when support is configured in development', () => {
    const csp = buildCsp({ devServerUrl: 'http://localhost:5173', noteWsUrl: 'wss://note.test', analyticsKey: null, gleapNonce: 'test-nonce' });
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://*.gleap.io;");
    expect(csp).not.toContain('nonce-');
  });
  it('packaged: self + note WSS only in connect-src, no analytics without a key', () => {
    const csp = buildCsp({
      devServerUrl: null,
      noteWsUrl: 'wss://note.prismical.ai/collaboration',
      analyticsKey: null,
      analyticsOrigin: 'https://us.i.posthog.com',
    });
    expect(csp).toContain("default-src 'self'");
    // Trailing ';' pins the packaged directive to 'self'-only (no dev-time
    // 'unsafe-inline' relaxation).
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("connect-src 'self' wss://note.prismical.ai");
    expect(csp).not.toContain('posthog');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('example.com');
    expect(csp).not.toContain('ws://');
  });

  it('adds the analytics origin only when a key is configured', () => {
    const csp = buildCsp({
      devServerUrl: null,
      noteWsUrl: 'wss://note.prismical.ai/collaboration',
      analyticsKey: 'phc_test',
      analyticsOrigin: 'https://us.i.posthog.com',
    });
    expect(csp).toContain('https://us.i.posthog.com');
  });

  it('dev: adds the HMR websocket for the dev-server origin', () => {
    const csp = buildCsp({
      devServerUrl: 'http://localhost:5173',
      noteWsUrl: 'wss://prismical-note.localhost/collaboration',
      analyticsKey: null,
    });
    expect(csp).toContain('ws://localhost:5173');
    // Asserted with the trailing delimiter, not as a bare prefix: `toContain` on the host alone
    // also matches `wss://prismical-note.localhost:1355`, so once the dev URL went port-less it
    // could no longer tell a wrong port from the right one.
    expect(csp).toContain('wss://prismical-note.localhost ');
    // Dev relaxes script-src for the react-refresh inline preamble.
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
  });
});

describe('resolveRendererAssetPath', () => {
  const dir = '/build/renderer/main_window';

  it('maps root-absolute paths into the renderer dir', () => {
    expect(resolveRendererAssetPath(dir, '/index.html')).toBe(`${dir}/index.html`);
    expect(resolveRendererAssetPath(dir, '/audio-recorder-processor.js')).toBe(
      `${dir}/audio-recorder-processor.js`
    );
    expect(resolveRendererAssetPath(dir, '/assets/index-abc.js')).toBe(`${dir}/assets/index-abc.js`);
  });

  it('serves index.html for the root path', () => {
    expect(resolveRendererAssetPath(dir, '/')).toBe(`${dir}/index.html`);
    expect(resolveRendererAssetPath(dir, '')).toBe(`${dir}/index.html`);
  });

  it('rejects traversal', () => {
    expect(resolveRendererAssetPath(dir, '/../secrets.txt')).toBeNull();
    expect(resolveRendererAssetPath(dir, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(resolveRendererAssetPath(dir, '/a/../../outside')).toBeNull();
  });
});

describe('computeMainWindowSize', () => {
  const size = (width: number, height: number) => computeMainWindowSize({ width, height });

  it('scales to the work area on a typical laptop, leaving it fully on-screen', () => {
    // 14" MBP and M2 Air work areas (menu bar + dock already excluded).
    expect(size(1512, 957)).toEqual({ width: 1285, height: 861 });
    expect(size(1470, 931)).toEqual({ width: 1250, height: 838 });
    // Comfortably larger than the old fixed 1100x720 it replaces…
    expect(size(1470, 931).width).toBeGreaterThan(1100);
    expect(size(1470, 931).height).toBeGreaterThan(720);
  });

  it('stays inside the work area for any display at or above the floor', () => {
    // Deliberately NOT "never exceeds the work area" — that is false below the
    // floor (see the min-size test), and naming it that way would let someone
    // raise MAIN_WINDOW_MIN_* and break small displays with the suite green.
    for (const [w, h] of [
      [1440, 875],
      [1512, 957],
      [1280, 700],
      [1024, 640],
      // The crossover itself: exactly at the floor, scaling would undershoot
      // (round(800*0.85)=680, round(480*0.9)=432) so the floor takes over and
      // the window exactly fills the work area — the last point where the
      // on-screen property still holds.
      [MAIN_WINDOW_MIN_WIDTH, MAIN_WINDOW_MIN_HEIGHT],
      // One notch above it, where scaling first wins again on both axes.
      [941, 534],
    ] as const) {
      const result = size(w, h);
      expect(result.width, `width for ${w}x${h}`).toBeLessThanOrEqual(w);
      expect(result.height, `height for ${w}x${h}`).toBeLessThanOrEqual(h);
    }
    expect(size(MAIN_WINDOW_MIN_WIDTH, MAIN_WINDOW_MIN_HEIGHT)).toEqual({
      width: MAIN_WINDOW_MIN_WIDTH,
      height: MAIN_WINDOW_MIN_HEIGHT,
    });
    expect(size(941, 534)).toEqual({ width: 800, height: 481 });
  });

  it('is total — a non-finite work area floors instead of reaching BrowserWindow as NaN', () => {
    const bad = { width: Number.NaN, height: Number.POSITIVE_INFINITY };
    expect(computeMainWindowSize(bad)).toEqual({
      width: MAIN_WINDOW_MIN_WIDTH,
      height: MAIN_WINDOW_MAX_HEIGHT,
    });
    expect(
      computeMainWindowSize({ width: undefined as unknown as number, height: 900 }).width
    ).toBe(MAIN_WINDOW_MIN_WIDTH);
  });

  it('caps on a large display rather than opening quasi-maximised', () => {
    expect(size(2560, 1400)).toEqual({
      width: MAIN_WINDOW_MAX_WIDTH,
      height: MAIN_WINDOW_MAX_HEIGHT,
    });
    expect(size(5120, 2880)).toEqual({
      width: MAIN_WINDOW_MAX_WIDTH,
      height: MAIN_WINDOW_MAX_HEIGHT,
    });
  });

  it('floors at the minimum so a tiny display cannot open below the sidebar breakpoint', () => {
    // Smaller than the floor: the window intentionally overflows rather than
    // rendering the shell below app-ui's md breakpoint.
    expect(size(640, 400)).toEqual({
      width: MAIN_WINDOW_MIN_WIDTH,
      height: MAIN_WINDOW_MIN_HEIGHT,
    });
    expect(size(0, 0)).toEqual({
      width: MAIN_WINDOW_MIN_WIDTH,
      height: MAIN_WINDOW_MIN_HEIGHT,
    });
  });
});
