/**
 * The notify window's main-world surface. The notify preload
 * (src/preload/notify.ts) exposes exactly `window.notify` = NotifyDesktopApi —
 * the card-stack stream + two verbs, nothing else.
 */
import type { NotifyDesktopApi } from '@prismical/desktop-contracts';

declare global {
  interface Window {
    readonly notify: NotifyDesktopApi;
  }
}

export {};
