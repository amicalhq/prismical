// EnvPort — environment seam shared by the renderers.
//
// The environment is INJECTED configuration: adapters are constructed with
// their values (web: the existing hostname-fallback resolvers, preserved
// bit-for-bit inside its adapter; desktop: main's `env:get` descriptor,
// resolved before the providers mount). The contract itself carries NO
// fallback and no resolution logic — a consumer that reaches for
// window.location.hostname instead of this port can make a packaged app
// silently talk to portless development URLs.

/**
 * What shared renderer code is allowed to know about its environment. Mirrors
 * the desktop `EnvDescriptor` (packages/desktop-contracts/src/main-window.ts)
 * field-for-field, so the desktop adapter passes main's descriptor through
 * untouched.
 */
export interface EnvDescriptor {
  /** Hocuspocus note-collaboration WebSocket URL (wss://…/collaboration). */
  readonly noteWsUrl: string;
  /**
   * The WEB app's origin, for minted share/invite/returnTo links
   * (`${webAppOrigin}/n/:token`, `/accept-invitation/:id`, connect-flow
   * returnTo). On desktop this stays the web origin — never the desktop
   * document origin.
   */
  readonly webAppOrigin: string;
  /** Analytics (PostHog) client key, or null when analytics is disabled. */
  readonly analyticsKey: string | null;
  /** "web" on the web app; process.platform on desktop. */
  readonly platform: string;
  /** App version on desktop; null on web (no surfaced version today). */
  readonly appVersion: string | null;
  /**
   * Core API base URL. Populated ONLY by web's adapter (and desktop MAIN's own
   * config) — never injected into the desktop renderer, which cannot reach
   * the server by construction; REST rides the TransportPort IPC lane there.
   * Shared code must not assume presence.
   */
  readonly coreApiUrl?: string;
}

export interface EnvPort {
  /**
   * The injected environment. Web resolves lazily per call (its resolvers read
   * the browser hostname exactly as today); desktop returns the descriptor it
   * was constructed with.
   */
  getEnv(): EnvDescriptor;
}
