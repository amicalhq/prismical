/**
 * Deep-link consumers, forked (forkScoped) by the boot program.
 *
 * - runDeepLinkConsumer: parses queued URLs; OAuthCallback and OAuthError are
 *   parked in pendingOAuth (AuthService consumes them — nothing exchanges
 *   codes yet), Navigate is pushed to the main window over the nav IPC channel,
 *   Unknown is counted in the warning log.
 * - runSecondInstanceConsumer: standard single-instance UX (focus the main
 *   window) + argv deep-link scan feeding the same queue as open-url.
 */
import { CHANNELS, type NavPush } from '@prismical/desktop-contracts';
import { Effect, Queue, SubscriptionRef } from 'effect';
import { AppConfig } from '../../infra/config/service';
import { ElectronApp } from '../../infra/electron/service';
import { MainLogger } from '../../infra/logging/service';
import { WindowRegistry } from '../windows/service';
import { deepLinksFromArgv, describeRejectedDeepLink, parseDeepLink } from './policy';
import { DeepLinks } from './service';

export const runDeepLinkConsumer: Effect.Effect<
  never,
  never,
  DeepLinks | WindowRegistry | AppConfig | MainLogger
> = Effect.gen(function* () {
  const config = yield* AppConfig;
  const deepLinks = yield* DeepLinks;
  const windows = yield* WindowRegistry;
  const log = (yield* MainLogger).scoped('deep-link');
  const options = { allowDevScheme: !config.isPackaged };

  return yield* Queue.take(deepLinks.urls).pipe(
    Effect.flatMap(url => {
      const parsed = parseDeepLink(url, options);
      switch (parsed._tag) {
        case 'OAuthCallback':
          // Values are secrets — log arrival only; redaction guards the rest.
          return log
            .info('oauth callback parked', { state: parsed.state.slice(0, 4) + '…' })
            .pipe(
              Effect.zipRight(
                SubscriptionRef.update(deepLinks.pendingOAuth, pending => [
                  ...pending,
                  {
                    _tag: 'OAuthCallback' as const,
                    code: parsed.code,
                    state: parsed.state,
                    receivedAt: Date.now(),
                  },
                ])
              )
            );
        case 'OAuthError':
          // The error name is a registry value (RFC 6749), not a secret; the
          // state stays prefix-only like the callback arm.
          return log
            .info('oauth error parked', {
              error: parsed.error,
              state: parsed.state === undefined ? undefined : parsed.state.slice(0, 4) + '…',
            })
            .pipe(
              Effect.zipRight(
                SubscriptionRef.update(deepLinks.pendingOAuth, pending => [
                  ...pending,
                  {
                    _tag: 'OAuthError' as const,
                    error: parsed.error,
                    ...(parsed.errorDescription === undefined
                      ? {}
                      : { errorDescription: parsed.errorDescription }),
                    ...(parsed.state === undefined ? {} : { state: parsed.state }),
                    receivedAt: Date.now(),
                  },
                ])
              )
            );
        case 'Navigate': {
          // /float* is the float-note WINDOW's private route family — a deep
          // link must never hijack the main window into the bare float view
          // and any webpage can mint prismical:// links.
          if (parsed.path.startsWith('/float')) {
            return log.warn('nav push rejected — float routes are not deep-linkable', {
              path: parsed.path,
            });
          }
          const payload: NavPush = { path: parsed.path };
          return windows
            .sendToMainWindow(CHANNELS.navPush, payload)
            .pipe(
              Effect.flatMap(sent =>
                sent
                  ? // 'dispatched', not 'delivered': webContents.send is fire-and-forget
                    // (the renderer may not have subscribed yet — the preload nav
                    // buffer replays it). Nothing here acknowledges receipt.
                    log.info('nav push dispatched', { path: parsed.path })
                  : log.warn('nav push dropped — no live main window', { path: parsed.path })
              )
            );
        }
        case 'Unknown':
          // NEVER the raw URL: several Unknown reasons carry real code/state
          // values (error-and-code, param-count, param-empty) — log param
          // Names only (describeRejectedDeepLink).
          return log.warn('deep link rejected', {
            url: describeRejectedDeepLink(parsed.url),
            reason: parsed.reason,
          });
      }
    }),
    Effect.forever
  );
});

/**
 * Cold-start deep-link seam (Windows/Linux). When the OS launches the WINNING
 * first instance with the link in argv (the Win/Linux delivery path), nothing
 * scanned process.argv — only the second-instance consumer did — so the link
 * was lost. Feed launch argv through the same offerUrl seam here.
 *
 * darwin is a deliberate no-op: macOS delivers cold-start links via open-url
 * (DeepLinksLive's feeder), so scanning argv there would double-offer. The
 * bounded url queue handles ordering vs the parsing consumer. The boot program
 * runs this once with process.argv, right after forking the consumers.
 */
export const offerLaunchDeepLinks = (
  argv: ReadonlyArray<string>
): Effect.Effect<void, never, DeepLinks | AppConfig | MainLogger> =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    if (config.platform === 'darwin') return;
    const deepLinks = yield* DeepLinks;
    const log = (yield* MainLogger).scoped('deep-link');
    const links = deepLinksFromArgv(argv, { allowDevScheme: !config.isPackaged });
    yield* Effect.forEach(links, url => deepLinks.offerUrl(url), { discard: true });
    if (links.length > 0) {
      yield* log.info('cold-start deep links offered', { count: links.length });
    }
  });

export const runSecondInstanceConsumer: Effect.Effect<
  never,
  never,
  DeepLinks | WindowRegistry | AppConfig | ElectronApp | MainLogger
> = Effect.gen(function* () {
  const config = yield* AppConfig;
  const electronApp = yield* ElectronApp;
  const deepLinks = yield* DeepLinks;
  const windows = yield* WindowRegistry;
  const log = (yield* MainLogger).scoped('deep-link');
  const options = { allowDevScheme: !config.isPackaged };

  return yield* Queue.take(electronApp.events.secondInstance).pipe(
    Effect.flatMap(({ argv }) =>
      windows.focusMainWindow.pipe(
        Effect.zipRight(
          Effect.forEach(deepLinksFromArgv(argv, options), url => deepLinks.offerUrl(url))
        ),
        Effect.zipRight(log.info('second instance handled', { argvLength: argv.length }))
      )
    ),
    Effect.forever
  );
});
