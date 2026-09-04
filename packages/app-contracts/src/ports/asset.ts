// AssetPort — asset seam shared by the renderers.
//
// Shared code must not hardcode root-absolute public asset paths as final
// URLs; it resolves them through this port. Both current adapters are
// near-identity (web serves /public verbatim; the desktop renderer is served
// from a rooted prismical-app:// scheme so root-absolute paths keep working) —
// the port exists so the resolution point is named and desktop can rebase
// (e.g. the AudioWorklet module URL) without touching shared code.

export interface AssetPort {
  /**
   * Resolve a root-absolute public asset path (e.g. "/prismical-icon.svg",
   * "/provider-logos/google.svg", "/audio-recorder-processor.js") to a URL
   * loadable on the current platform.
   */
  resolve(path: string): string;
}
