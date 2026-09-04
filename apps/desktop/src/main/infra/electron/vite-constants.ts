/**
 * Safe accessors for the @electron-forge/plugin-vite define constants. They
 * only exist inside the built main bundle; vitest (plain node) sees neither,
 * so every read goes through a typeof guard.
 */
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

export const mainWindowDevServerUrl = (): string | null =>
  typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'undefined'
    ? null
    : (MAIN_WINDOW_VITE_DEV_SERVER_URL ?? null);

export const mainWindowViteName = (): string =>
  typeof MAIN_WINDOW_VITE_NAME === 'undefined' ? 'main_window' : MAIN_WINDOW_VITE_NAME;
