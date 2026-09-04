// Web Storage bridge for vitest's jsdom environment. Shared by every package whose jsdom suites
// touch localStorage/sessionStorage — wire it in with
// `test.setupFiles` (for example, app-client uses `./vitest.jsdom-storage.setup.ts`).
//
// vitest 3.2.4 builds a jsdom window and mirrors its keys onto the test global. With jsdom 29
// that mirroring drops Web Storage: the real window has working storage
// (`globalThis.jsdom.window.localStorage` reads and writes fine), but both `globalThis.localStorage`
// and `window.localStorage` resolve to `undefined`. Suites then die on
// `Cannot read properties of undefined (reading 'clear')` — which is what had
// the web authentication storage tests and
// `packages/app-client/src/recording/use-recording.test.tsx` (12 cases) red.
//
// Point both spellings at the real window. Guarded on `globalThis.jsdom`, so this is a no-op in
// node-environment files, and on the value already being present, so it stops doing anything once
// vitest and jsdom agree again — at which point delete this file and its `setupFiles` entries.

type StorageKey = "localStorage" | "sessionStorage";

const dom = (globalThis as { jsdom?: { window: Record<StorageKey, Storage> } }).jsdom;

if (dom?.window) {
  // `globalThis.window` is NOT the jsdom window under vitest, so patching one does not cover the
  // other: the web app reads bare `localStorage`, app-client reads `window.localStorage`.
  const windowRef = (globalThis as { window?: object }).window;
  const targets = new Set<object>([globalThis, windowRef ?? globalThis]);

  for (const key of ["localStorage", "sessionStorage"] as const) {
    if (dom.window[key] == null) continue;
    for (const target of targets) {
      if ((target as Partial<Record<StorageKey, unknown>>)[key] != null) continue;
      Object.defineProperty(target, key, {
        configurable: true,
        get: () => dom.window[key],
      });
    }
  }
}
