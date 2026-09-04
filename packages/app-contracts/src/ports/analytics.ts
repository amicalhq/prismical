// AnalyticsPort — analytics seam shared by the renderers.
//
// Deliberately minimal: platform-specific analytics configuration,
// super-properties, and the identity lifecycle stay inside adapters. Shared
// code needs only event capture and SPA pageviews. The desktop adapter wires
// nothing here while its analytics origin is null.

export type AnalyticsEventProperties = Record<
  string,
  string | number | boolean | null | undefined
>;

export interface AnalyticsPort {
  /** Capture a product event. Must no-op wherever analytics is disabled. */
  capture(event: string, properties?: AnalyticsEventProperties): void;
  /**
   * SPA pageview for a route change. `url` is the full current URL, minted by
   * the caller (origin + pathname + query — web keeps today's
   * window.location.origin-based minting until the desktop adapter owns it).
   */
  capturePageview(url: string): void;
}
