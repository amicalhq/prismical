/**
 * Dev-only loopback OAuth receiver.
 *
 * Unpackaged builds cannot reliably receive custom-scheme deep links on macOS:
 * every electron dev checkout on the machine shares the bundle id
 * `com.github.Electron`, and LaunchServices routes a scheme by bundle id — so
 * `prismical-dev://` can (and does) launch a bare Electron welcome window from
 * some OTHER repo's node_modules instead of reaching the running app.
 *
 * Dev sign-in therefore redirects to `http://127.0.0.1:<port>/oauth/callback`
 * (the standard native-app loopback pattern, RFC 8252 §7.3). This server
 * re-encodes the query as a `prismical-dev://oauth/callback?…` URL and offers
 * it through the SAME deep-link queue, so parsing, state matching, single-use
 * consumption and the exchange pipeline are identical to the packaged path.
 *
 * Packaged builds return immediately — they keep the real `prismical://`
 * scheme (a real .app bundle owns its id, so LaunchServices routes correctly).
 */
import { createServer } from 'node:http';
import { Effect, Runtime } from 'effect';
import { AppConfig } from '../../infra/config/service';
import { MainLogger } from '../../infra/logging/service';
import { DeepLinks } from './service';

/** Fixed dev loopback port — mirrored in the config's dev redirectUri and the
 * seeded OAuth client allowlist (seed-oauth-client.ts). */
export const DEV_LOOPBACK_PORT = 17829;

export const runDevLoopbackOAuthServer: Effect.Effect<
  void,
  never,
  DeepLinks | AppConfig | MainLogger
> = Effect.gen(function* () {
  const config = yield* AppConfig;
  if (config.isPackaged) return;
  const deepLinks = yield* DeepLinks;
  const log = (yield* MainLogger).scoped('deep-link');
  // Node-callback → Effect boundary: fork on THIS runtime, not the default one
  // The stray Effect.runFork sites were benign only because the services were
  // already closed over.
  const runtime = yield* Effect.runtime<never>();
  const forkHere = Runtime.runFork(runtime);

  // Held open for the app's lifetime; the async canceller closes the server
  // when the boot scope interrupts the fiber (quit).
  yield* Effect.async<never>(_resume => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${DEV_LOOPBACK_PORT}`);
      if (url.pathname !== '/oauth/callback') {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      // Values are secrets — never logged; the queue consumer redacts too.
      forkHere(
        deepLinks
          .offerUrl(`prismical-dev://oauth/callback${url.search}`)
          .pipe(Effect.zipRight(log.info('loopback oauth callback offered')))
      );
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        '<!doctype html><title>Prismical</title>' +
          '<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0f1013;color:#e7e7ea">' +
          '<p>Signed in - you can close this tab and return to Prismical.</p>'
      );
    });
    server.once('error', (error: NodeJS.ErrnoException) => {
      // EADDRINUSE = a second dev instance already listens; that instance will
      // receive the callback instead. Warn, do not crash the boot.
      forkHere(
        log.warn('dev loopback oauth server failed to listen', {
          code: error.code,
          port: DEV_LOOPBACK_PORT,
        })
      );
    });
    server.listen(DEV_LOOPBACK_PORT, '127.0.0.1', () => {
      forkHere(log.info('dev loopback oauth server listening', { port: DEV_LOOPBACK_PORT }));
    });
    return Effect.sync(() => {
      server.close();
    });
  });
});
