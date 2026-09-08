/** Renderer analytics are relayed to main, which owns policy, identity and PostHog. */
import type { AnalyticsPort } from '@prismical/app-contracts';
import { getTelemetryState } from '../../../telemetry';

export const desktopAnalyticsPort: AnalyticsPort = {
  capture(event, properties) {
    const state = getTelemetryState();
    if (!state?.enabled) return;
    void window.desktop.telemetry.capture({ event, properties, revision: state.revision }).catch(() => {});
  },
  capturePageview(url) {
    const state = getTelemetryState();
    if (!state?.enabled) return;
    let route = 'unknown';
    try {
      const parsed = new URL(url);
      const path = parsed.hash.startsWith('#/') ? parsed.hash.slice(1).split('?')[0] : parsed.pathname;
      if (path === '/' || path === '/notes') route = 'main';
      else if (path === '/settings' || path.startsWith('/settings/')) route = 'settings';
      else if (path.startsWith('/notes/') || path.startsWith('/float/')) route = 'note';
    } catch {
      // An invalid location has no useful route identity.
    }
    void window.desktop.telemetry.capture({ event: 'page_viewed', properties: { route }, revision: state.revision }).catch(() => {});
  },
};
