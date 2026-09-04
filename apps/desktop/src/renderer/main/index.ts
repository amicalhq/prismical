// Renderer entry: resolve main's immutable application locale before either
// React root mounts, then give the exact same i18n instance to the pre-auth gate
// and the shared @prismical/app-ui shell. The gate stays mounted FIRST in its
// own root; the shell mounts beside it and paints over the signed-in placeholder
// once an account is active. Both read the same multi-subscriber session buffer.
// The streaming prototype hook stays for the e2e suite, gated behind the
// e2e-only preload surface so a production build exposes no test API.
import { mountAuthGate } from './auth-gate';
import { mountAppShell } from './app/mount';
import { openAskStream, type AskStreamHandle } from './stream';
import { createDesktopRendererI18n } from './application-i18n';
import { mountRendererBootstrapFailure } from './bootstrap-failure';

declare global {
  interface Window {
    __desktopStreamTest?: {
      open: typeof openAskStream;
      collect: (
        handle: AskStreamHandle,
        until: (events: unknown[]) => boolean
      ) => Promise<unknown[]>;
    };
  }
}

// Theme boot — mirrors the browser client's inline <head> script (the window CSP's
// script-src 'self' forbids an inline tag here, so it runs first in the entry
// module instead): apply the stored theme class before anything paints, so the
// shell (and the mac hiddenInset chrome behind it) never flashes the wrong mode.
// Unlike web, this also tracks live OS-theme flips: main re-skins the Windows
// titleBarOverlay on nativeTheme 'updated', so a 'system'-themed renderer must
// follow along or the native strip and the shell go two-tone.
const applyStoredTheme = (): void => {
  try {
    const storedTheme = localStorage.getItem('theme') ?? 'system';
    const prefersDark =
      storedTheme === 'dark' ||
      (storedTheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', prefersDark);
    // Mirror the PREFERENCE (never the resolved light/dark) to main: it drives
    // nativeTheme.themeSource, and resolving 'system' here would pin
    // prefers-color-scheme and strand the app on one appearance. Fire-and-forget
    // — native chrome tracking the OS for a moment longer is cosmetic.
    if (storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'system') {
      void window.desktop.theme.setSource(storedTheme);
    }
  } catch {
    // Storage unavailable — keep the default (light) theme.
  }
};
applyStoredTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyStoredTheme);

// The shared ThemeToggle (packages/app-ui) writes localStorage and flips the
// `dark` class itself — it has no desktop seam to call, and web must not grow
// one. Watching the class attribute is the desktop-local way to notice, and it
// re-reads the PREFERENCE rather than trusting the resolved class. A toggle that
// doesn't change the class (e.g. 'system'→'dark' while the OS is already dark)
// leaves themeSource stale but visually identical, and the matchMedia listener
// above repairs it on the next OS flip — which is the only moment it can matter.
new MutationObserver(applyStoredTheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['class'],
});

// The float-note window rides this same bundle at #/float:
// it must stay TRANSPARENT (its rounded surface is drawn by FloatNoteView), so
// it skips the vibrancy material, the opaque body background, and the
// auth-gate root (the gate is main-window chrome; the float renders nothing
// signed out).
const isFloatWindow = window.location.hash.startsWith('#/float');
if (isFloatWindow) {
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'transparent';
}

// macOS vibrancy opt-in — the renderer half of the `vibrancy: 'menu'` window in
// domains/windows/live.ts; this class arms the `html.vibrancy` rules in
// app/globals.css. darwin-only: no other platform mounts the material.
if (window.desktop.platform === 'darwin' && !isFloatWindow) {
  document.documentElement.classList.add('vibrancy');
}

const root = document.getElementById('root');
if (root === null) {
  throw new Error('renderer mount point #root missing');
}

const bootstrap = async (): Promise<void> => {
  const [desktopEnv, settings, appModeState] = await Promise.all([
    window.desktop.env.get(),
    window.desktop.settings.get(),
    // Whether a mode was ever chosen. A fresh install boots
    // 'cloud' by default (appMode below) but the mode router shows the
    // first-run chooser until this says chosen.
    window.desktop.capabilities.getAppModeState(),
  ]);
  const applicationI18n = createDesktopRendererI18n(
    desktopEnv.applicationLocale,
    settings.language
  );
  document.documentElement.lang = applicationI18n.locale;

  // Local mode never mounts the gate: there is no sign-in
  // surface, and the gate's drag strip is an app-region rect Chromium never
  // subtracts by stacking — left under the shell it would swallow top-strip
  // clicks forever. The mode router (mount.tsx) renders the shell in local
  // mode; on a fresh install (cloud by default, nothing chosen) it paints the
  // first-run chooser OVER this gate until a mode is picked.
  // While no mode is chosen the gate is mounted INERT: the chooser paints over
  // it, and it must not be reachable by keyboard underneath (a sign-in started
  // under the chooser would carry a cloud roster into a later local choice).
  const gate =
    !isFloatWindow && desktopEnv.appMode !== 'local'
      ? mountAuthGate(root, applicationI18n.instance, { inert: !appModeState.chosen })
      : null;

  // In cloud mode the shell renders nothing until an account is active, so the
  // gate above owns the pre-auth surface. Both roots share the exact same i18n
  // instance. Choosing the boot mode (cloud) in-process hands the surface to
  // the gate by lifting `inert`.
  await mountAppShell(root, desktopEnv, applicationI18n, appModeState, {
    onModeChosen: () => gate?.setInert(false),
  });
};

void bootstrap().catch(error => {
  console.error('Failed to initialize the desktop renderer', error);
  mountRendererBootstrapFailure(root);
});

// e2e hook for the Ask streaming specs: open the real Ask stream and
// parse the SSE UI-message-stream off the Response body until a predicate holds.
// Each `data: {json}` frame is parsed to a chunk object; the `data: [DONE]`
// terminator surfaces as { type: '[DONE]' }. Present ONLY when the e2e preload
// surface exists (PRISMICAL_E2E=1 runs).
if (window.desktop.e2e !== undefined) {
  window.__desktopStreamTest = {
    open: openAskStream,
    collect: async (handle, until) => {
      const response = await handle.response;
      if (response.body === null) throw new Error('stream response has no body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const events: unknown[] = [];
      const pushDataLine = (line: string): void => {
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (payload.length === 0) return;
        if (payload === '[DONE]') {
          events.push({ type: '[DONE]' });
          return;
        }
        try {
          events.push(JSON.parse(payload));
        } catch {
          // A partial/non-JSON data line — ignore (never reached with well-formed SSE).
        }
      };
      let buffered = '';
      while (!until(events)) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        // SSE events are separated by a blank line (\n\n).
        let sep = buffered.indexOf('\n\n');
        while (sep >= 0) {
          const frame = buffered.slice(0, sep);
          buffered = buffered.slice(sep + 2);
          for (const line of frame.split('\n')) pushDataLine(line);
          sep = buffered.indexOf('\n\n');
        }
      }
      reader.releaseLock();
      return events;
    },
  };
}

export {};
