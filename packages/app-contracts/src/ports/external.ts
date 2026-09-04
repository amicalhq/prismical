// ExternalPort — external-action seam shared by the renderers.
//
// Covers every way the app deliberately leaves its own surface. Link MINTING
// (share/invite/returnTo URLs) is not here — that is EnvPort.webAppOrigin.

export interface ExternalPort {
  /**
   * Provider-authorization hand-off that re-enters the app via its returnTo
   * (calendar connect, MCP-server connect — the flows that today do
   * `window.location.assign(providerUrl)`). Web: full-page navigation;
   * desktop: system browser + prismical:// deep-link return (one adapter
   * covers both flows — core's returnTo allowlist already admits the scheme).
   */
  openAuthorizationUrl(url: string): void;
  /**
   * The `returnTo` an authorization hand-off should carry so the provider
   * round-trip lands back on the in-app route `appPath` (e.g. "/settings/
   * calendar"; must start with "/"). This is where the flow RE-ENTERS the app,
   * and it differs by platform — so it belongs here, beside the hand-off itself,
   * rather than being minted from EnvPort.webAppOrigin at the call site:
   *  - Web: `${webAppOrigin}${appPath}` — the same origin, so the round-trip is
   *    a full-page navigation that reloads the app fresh (queries refetch).
   *  - Desktop: a `prismical://app${appPath}` deep link. The system-browser
   *    round-trip redirects to it, the OS routes it to the ALREADY-RUNNING app
   *    (focusing it), and the deep-link boundary parses it as a renderer
   *    Navigate — so the user returns to the app they launched from instead of
   *    being stranded on the web app in a browser tab. (core's returnTo
   *    allowlist already admits the scheme.) There is no reload, so the landing
   *    screen must refetch on the `?connected=1`/`?error=…` it arrives with.
   */
  authorizationReturnTo(appPath: string): string;
  /**
   * Open an external URL OUTSIDE the app (docs, provider sites). Web:
   * window.open in a new tab (noopener); desktop: shell.openExternal.
   */
  openExternalUrl(url: string): void;
}
