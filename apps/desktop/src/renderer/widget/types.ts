/**
 * The widget window's main-world surface. The widget preload
 * (src/preload/widget.ts) exposes exactly `window.widget` = WidgetDesktopApi —
 * the state stream + five command verbs, nothing else.
 */
import type { WidgetDesktopApi } from '@prismical/desktop-contracts';

declare global {
  interface Window {
    readonly widget: WidgetDesktopApi;
  }
}

export {};
