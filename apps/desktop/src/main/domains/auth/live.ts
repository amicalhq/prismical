/**
 * AuthService live layer: main-owned PKCE flow, JSON token exchange,
 * validated ID token claims, safeStorage-backed refresh tokens, single-flight
 * refresh with scheduled + resume/focus re-checks.
 *
 * Secrets discipline: the refresh token exists only inside
 * SecureStore ('auth.refreshToken.<sub>'); id/access tokens live ONLY in the
 * in-memory tokensRef. Nothing token-shaped enters sessionState, the settings
 * index, or a log call.
 */
import { desktopFetch } from '../../infra/http/client';
import { randomBytes } from 'node:crypto';
import { shell } from 'electron';
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Ref,
  Scope,
  SubscriptionRef,
} from 'effect';
import { AppConfig } from '../../infra/config/service';
import { ElectronApp } from '../../infra/electron/service';
import { MainLogger } from '../../infra/logging/service';
import { OperationalDb, type DbError } from '../../infra/operational-db/service';
import { SecureStore, SecureStoreError } from '../../infra/secure-store/service';
import type { PendingOAuthEntry } from '../deep-link/service';
import { isAllowedExternalUrl } from '../windows/policy';
import { WindowRegistry } from '../windows/service';
import {
  applyRefreshedIdentity,
  applySignIn,
  applyTransientRefreshFailure,
  buildAuthorizeUrl,
  challengeForVerifier,
  dropAccount,
  encodeAccountIndex,
  idleAttempt,
  initialAuthState,
  launchAttempt,
  makePkceMaterial,
  matchAttempt,
  parseIdToken,
  parseTokenResponse,
  restoreAuthState,
  setAccountOrg,
  type AttemptMatch,
  type AuthAttempt,
  type AuthState,
  type IdTokenIdentity,
  type ParsedTokenResponse,
  type RandomSource,
} from './policy';
import {
  AuthFlowError,
  AuthService,
  AuthStateError,
  RefreshError,
  RevokeError,
  TokenExchangeError,
  TokenVerificationError,
  WebSessionHandoffError,
  type AuthApi,
  type PendingEntryVerdict,
} from './service';

/** Refresh this long before the access/id token expiry. */
export const EXPIRY_SKEW_MS = 10 * 60 * 1000;
/** Token endpoint budget: a hung refresh must not wedge auth. */
export const TOKEN_REQUEST_TIMEOUT = Duration.seconds(15);
/** Revocation is best-effort — a short bound keeps sign-out snappy. */
export const REVOKE_TIMEOUT = Duration.seconds(5);
export const WEB_HANDOFF_TIMEOUT = Duration.seconds(15);
/** Scheduler re-check cadence while no refresh deadline is known. */
const SCHEDULER_IDLE_POLL = Duration.minutes(1);
/**
 * Scheduler sleep floor: a token lifetime ≤ EXPIRY_SKEW makes every freshly
 * minted token immediately "due" — without a floor the loop would refresh at
 * HTTP-round-trip rate (one rotation per iteration), hammering the endpoint.
 */
const SCHEDULER_MIN_SLEEP_MS = 1_000;
/** Transient-failure backoff: 30s doubling to a 10-minute ceiling. */
const REFRESH_BACKOFF_BASE_MS = 30_000;
const REFRESH_BACKOFF_CAP_MS = 10 * 60 * 1000;

export const ACCOUNT_INDEX_KEY = 'auth.accounts';
export const refreshTokenKey = (sub: string): string => `auth.refreshToken.${sub}`;

const subPrefix = (sub: string): string => sub.slice(0, 6) + '…';
const statePrefix = (state: string): string => state.slice(0, 4) + '…';
const SAFE_WEB_RETURN_PATH = /^\/(?!\/)[A-Za-z0-9_\-./?=&%#]*$/;

/** Literal IPv4 / bracketed-IPv6 hosts have no label structure to widen over. */
const isIpHost = (hostname: string): boolean =>
  /^\d+(\.\d+){3}$/.test(hostname) || hostname.includes(':');

/**
 * Trusted parent domain of the configured web-app origin: DROP the first
 * label when the hostname has three or more ("app.prismical.ai" →
 * "prismical.ai", "app.example.co.uk" → "example.co.uk"), else the hostname
 * itself. Drop-one (not keep-two) so a multi-part public suffix never becomes
 * the trust root — keep-two would turn app.example.co.uk into "co.uk" and
 * accept every attacker-registrable *.co.uk sibling. No PSL needed: the
 * result is always a REGISTERED name the deployer controls (their own
 * origin's parent), never a bare suffix.
 */
const apexOf = (hostname: string): string => {
  const labels = hostname.split('.');
  return labels.length >= 3 ? labels.slice(1).join('.') : hostname;
};

// The handoff URL core returns must stay inside the CONFIGURED web product
// (exact origin, or the configured origin's apex + subdomains). Derived from
// config rather than a baked production hostname — an OSS build pointed at
// another deployment must not implicitly
// trust prismical.ai, and the production behavior is unchanged
// (app.prismical.ai ⇒ prismical.ai + *.prismical.ai).
const isAllowedWebHandoffUrl = (url: URL, configuredOrigin: string): boolean => {
  if (url.protocol !== 'https:') return false;
  if (url.origin === configuredOrigin) return true;
  let configuredHost: string;
  try {
    configuredHost = new URL(configuredOrigin).hostname;
  } catch {
    return false;
  }
  // IP-literal origins carry no domain hierarchy: exact origin only.
  if (isIpHost(configuredHost) || isIpHost(url.hostname)) return false;
  const apex = apexOf(configuredHost);
  return url.hostname === apex || url.hostname.endsWith(`.${apex}`);
};

interface TokenSet {
  readonly idToken: string;
  readonly accessToken: string;
  readonly expiresAt: number;
}

interface RetryMeta {
  readonly at: number;
  readonly failures: number;
}

export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal: AbortSignal;
  }
) => Promise<Response>;

interface HttpFailure {
  readonly kind: 'network' | 'timeout';
  readonly cause?: unknown;
}

export interface AuthLiveOptions {
  /** Injected for tests; defaults to the ambient main-process fetch. */
  readonly fetchFn?: FetchLike;
  /** Injected for tests (fixed PKCE vectors); defaults to node:crypto randomBytes. */
  readonly randomSource?: RandomSource;
}

export const makeAuthLive = (
  options: AuthLiveOptions = {}
): Layer.Layer<
  AuthService,
  never,
  AppConfig | SecureStore | OperationalDb | ElectronApp | WindowRegistry | MainLogger
> =>
  Layer.scoped(
    AuthService,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const secureStore = yield* SecureStore;
      const db = yield* OperationalDb;
      const electronApp = yield* ElectronApp;
      const windows = yield* WindowRegistry;
      const log = (yield* MainLogger).scoped('auth');

      const fetchFn: FetchLike = options.fetchFn ?? desktopFetch;
      const random: RandomSource = options.randomSource ?? (length => randomBytes(length));

      // Restore the non-secret account roster; corruption degrades to
      // signed-out — restore must never fail the boot layer.
      const restored = yield* db.getSetting(ACCOUNT_INDEX_KEY).pipe(
        Effect.map(restoreAuthState),
        Effect.catchAll(cause =>
          log
            .error('account index unreadable — starting signed-out', { error: cause })
            .pipe(Effect.as(initialAuthState))
        )
      );

      const sessionState = yield* SubscriptionRef.make(restored);
      // One pending attempt slot. Memory-only: closing the layer scope
      // clears it — a half-done browser dance never survives a restart. A
      // user-driven signIn replaces a parked attempt; this ref
      // only single-flights CONCURRENT invokes across the launch window.
      const attemptRef = yield* Ref.make<AuthAttempt>(idleAttempt);
      const signInInFlightRef = yield* Ref.make(false);
      const tokensRef = yield* Ref.make<ReadonlyMap<string, TokenSet>>(new Map());
      const inflightRef = yield* Ref.make<
        ReadonlyMap<string, Deferred.Deferred<string, RefreshError>>
      >(new Map());
      const retryRef = yield* Ref.make<ReadonlyMap<string, RetryMeta>>(new Map());

      // Refresh flights run in fibers attached to THIS scope, never on caller
      // fibers: once the token POST is on the wire the server may already have
      // consumed the refresh token (zero grace), so a dying caller (session
      // scope close, abandoned getIdToken) must never abort the flight. Only
      // the finalizer below reaps it.
      const flightScope = yield* Scope.make();
      // Quit path: AWAIT in-flight refreshes before the layer closes so a
      // committed rotation always reaches the store. The await is bounded by
      // TOKEN_REQUEST_TIMEOUT (each flight's send already is), so quit cannot
      // wedge here — and shutdown's DISPOSE_DEADLINE force-exits regardless; a
      // refresh cut off by THAT is indistinguishable from a crash, which
      // core's 10 h refresh-replay cache absorbs. Registered before the
      // background fibers below, so on close (LIFO) they are already
      // interrupted and no new flight can start while this drains.
      yield* Effect.addFinalizer(() =>
        Ref.get(inflightRef).pipe(
          Effect.flatMap(inflight =>
            Effect.forEach(inflight.values(), flight => Deferred.await(flight).pipe(Effect.ignore), {
              discard: true,
            })
          ),
          Effect.timeout(TOKEN_REQUEST_TIMEOUT),
          Effect.ignore,
          Effect.zipRight(Scope.close(flightScope, Exit.void))
        )
      );

      const persistIndex: Effect.Effect<void, DbError> = SubscriptionRef.get(sessionState).pipe(
        Effect.flatMap(state => db.setSetting(ACCOUNT_INDEX_KEY, encodeAccountIndex(state)))
      );
      const persistIndexLogged = persistIndex.pipe(
        Effect.catchAll(cause => log.error('account index write failed', { error: cause }))
      );

      const postJson = (
        url: string,
        body: Record<string, string>,
        timeout: Duration.Duration,
        extraHeaders: Record<string, string> = {}
      ): Effect.Effect<Response, HttpFailure> =>
        Effect.tryPromise({
          try: signal =>
            fetchFn(url, {
              method: 'POST',
              headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                ...extraHeaders,
              },
              body: JSON.stringify(body),
              signal,
            }),
          catch: cause => ({ kind: 'network' as const, cause }),
        }).pipe(
          Effect.timeoutFail({ duration: timeout, onTimeout: () => ({ kind: 'timeout' as const }) })
        );

      const readJson = <E>(response: Response, onError: (cause: unknown) => E) =>
        Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: onError,
        });

      // ----- claims from the configured token endpoint ------------------------

      const validateIdToken = (
        idToken: string
      ): Effect.Effect<IdTokenIdentity, TokenVerificationError> =>
        Effect.sync(() =>
          parseIdToken(idToken, {
            issuer: config.auth.issuer,
            audience: config.auth.oauthClientId,
            nowMs: Date.now(),
          })
        ).pipe(
          Effect.flatMap(identity =>
            identity.ok
              ? Effect.succeed(identity.value)
              : Effect.fail(new TokenVerificationError({ reason: identity.reason }))
          )
        );

      // ----- revocation (best-effort caller-side; typed here) ----------------

      const revokeToken = (token: string): Effect.Effect<void, RevokeError> =>
        postJson(
          config.auth.revokeUrl,
          // Public client — token + client_id only, NEVER a client_secret.
          { token, client_id: config.auth.oauthClientId },
          REVOKE_TIMEOUT
        ).pipe(
          Effect.mapError(
            failure =>
              new RevokeError(
                failure.kind === 'timeout'
                  ? { reason: 'timeout' }
                  : { reason: 'network', cause: failure.cause }
              )
          ),
          Effect.flatMap(response =>
            response.ok
              ? Effect.void
              : Effect.fail(new RevokeError({ reason: 'http', status: response.status }))
          )
        );

      // ----- code exchange ----------------------------------------------------

      const exchangeCode = (
        code: string,
        verifier: string
      ): Effect.Effect<ParsedTokenResponse, TokenExchangeError> =>
        postJson(
          config.auth.tokenUrl,
          {
            grant_type: 'authorization_code',
            code,
            client_id: config.auth.oauthClientId,
            redirect_uri: config.auth.redirectUri,
            code_verifier: verifier,
          },
          TOKEN_REQUEST_TIMEOUT
        ).pipe(
          Effect.mapError(
            failure =>
              new TokenExchangeError(
                failure.kind === 'timeout'
                  ? { reason: 'timeout' }
                  : { reason: 'network', cause: failure.cause }
              )
          ),
          Effect.flatMap(response =>
            response.ok
              ? readJson(
                  response,
                  cause => new TokenExchangeError({ reason: 'invalid-response', cause })
                )
              : Effect.fail(new TokenExchangeError({ reason: 'http', status: response.status }))
          ),
          Effect.flatMap(body =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap(now => {
                const parsed = parseTokenResponse(body, now);
                return parsed.ok
                  ? Effect.succeed(parsed.value)
                  : Effect.fail(
                      new TokenExchangeError({ reason: 'invalid-response', cause: parsed.issue })
                    );
              })
            )
          )
        );

      const completeExchange = (
        code: string,
        verifier: string
      ): Effect.Effect<
        void,
        TokenExchangeError | TokenVerificationError | SecureStoreError | DbError
      > =>
        Effect.gen(function* () {
          const tokens = yield* exchangeCode(code, verifier);
          const identity = yield* validateIdToken(tokens.idToken).pipe(
            Effect.tapError(() =>
              // The exchange minted credentials we refuse to trust — revoke
              // them best-effort so they don't linger server-side.
              tokens.refreshToken === null
                ? Effect.void
                : revokeToken(tokens.refreshToken).pipe(Effect.ignore)
            )
          );
          if (tokens.refreshToken !== null) {
            const refreshToken = tokens.refreshToken;
            yield* secureStore.setSecret(refreshTokenKey(identity.sub), refreshToken).pipe(
              // Same custody rule as the verify tap above: a mint we cannot
              // take custody of must not linger live server-side.
              Effect.tapError(() => revokeToken(refreshToken).pipe(Effect.ignore))
            );
          } else {
            yield* log.warn('exchange response had no refresh_token — session will not survive restart', { context: {
              sub: subPrefix(identity.sub),
            } });
          }
          yield* Ref.update(tokensRef, map =>
            new Map(map).set(identity.sub, {
              idToken: tokens.idToken,
              accessToken: tokens.accessToken,
              expiresAt: tokens.expiresAt,
            })
          );
          yield* SubscriptionRef.update(sessionState, state => applySignIn(state, identity));
          // Sign-in is committed (secret + state) — an index write failure must
          // not fail a succeeded sign-in into 'exchange-failed'; it degrades to
          // a logged error and self-heals on the next persist (refresh,
          // account/org switch, sign-out).
          yield* persistIndexLogged;
          yield* log.info('sign-in complete', { context: { sub: subPrefix(identity.sub) } });
        });

      // ----- refresh (single-flight; rotation has ZERO grace) -----------------

      const dropAccountEffect = (sub: string, reason: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* secureStore
            .deleteSecret(refreshTokenKey(sub))
            .pipe(Effect.catchAll(cause => log.error('secret wipe failed', { error: cause })));
          yield* Ref.update(tokensRef, map => {
            const next = new Map(map);
            next.delete(sub);
            return next;
          });
          yield* Ref.update(retryRef, map => {
            const next = new Map(map);
            next.delete(sub);
            return next;
          });
          yield* SubscriptionRef.update(sessionState, state => dropAccount(state, sub));
          yield* persistIndexLogged;
          yield* log.warn('account dropped', { context: { sub: subPrefix(sub), reason } });
        });

      const settleRefreshFailure = (sub: string, error: RefreshError): Effect.Effect<void> =>
        error.reason === 'revoked' ||
        error.reason === 'no-refresh-token' ||
        error.reason === 'persist-failed'
          ? dropAccountEffect(sub, error.reason)
          : Effect.gen(function* () {
              const state = yield* SubscriptionRef.get(sessionState);
              if (state.accounts[sub] === undefined) {
                // Removed mid-flight (signOut raced the refresh): a backoff
                // entry would leak — nothing prunes retryRef for absent subs.
                return;
              }
              const now = yield* Clock.currentTimeMillis;
              const failures = ((yield* Ref.get(retryRef)).get(sub)?.failures ?? 0) + 1;
              const backoff = Math.min(
                REFRESH_BACKOFF_BASE_MS * 2 ** (failures - 1),
                REFRESH_BACKOFF_CAP_MS
              );
              yield* Ref.update(retryRef, map =>
                new Map(map).set(sub, { at: now + backoff, failures })
              );
              const tokens = (yield* Ref.get(tokensRef)).get(sub);
              const hasValidToken = tokens !== undefined && tokens.expiresAt > now;
              yield* SubscriptionRef.update(sessionState, state =>
                applyTransientRefreshFailure(state, sub, hasValidToken)
              );
              yield* log.warn('refresh failed transiently — account kept', { context: {
                sub: subPrefix(sub),
                reason: error.reason,
                status: error.status,
                retryInMs: backoff,
              } });
            });

      const runRefresh = (sub: string): Effect.Effect<string, RefreshError> =>
        Effect.gen(function* () {
          const secret = yield* secureStore.getSecret(refreshTokenKey(sub)).pipe(
            Effect.mapError(cause =>
              // Undecryptable ciphertext (keychain reset) is as definitive as a
              // missing secret; a DB hiccup is transient.
              cause instanceof SecureStoreError && cause.reason === 'decrypt-failed'
                ? new RefreshError({ reason: 'no-refresh-token', cause })
                : new RefreshError({ reason: 'transient', cause })
            )
          );
          if (secret === null) {
            return yield* Effect.fail(new RefreshError({ reason: 'no-refresh-token' }));
          }
          const response = yield* postJson(
            config.auth.tokenUrl,
            { grant_type: 'refresh_token', client_id: config.auth.oauthClientId, refresh_token: secret },
            TOKEN_REQUEST_TIMEOUT
          ).pipe(
            Effect.mapError(failure => new RefreshError({ reason: 'transient', cause: failure }))
          );
          if (response.status === 400 || response.status === 401) {
            // Definitive rejection (revoked/rotated-away). NEVER retried with
            // this token — a replay would trip family invalidation.
            return yield* Effect.fail(
              new RefreshError({ reason: 'revoked', status: response.status })
            );
          }
          if (!response.ok) {
            return yield* Effect.fail(
              new RefreshError({ reason: 'transient', status: response.status })
            );
          }
          const body = yield* readJson(
            response,
            cause => new RefreshError({ reason: 'transient', cause })
          );
          const now = yield* Clock.currentTimeMillis;
          const parsed = parseTokenResponse(body, now);
          if (!parsed.ok) {
            return yield* Effect.fail(new RefreshError({ reason: 'transient', cause: parsed.issue }));
          }
          const rotated = parsed.value.refreshToken;
          // Zero-grace rotation: the old refresh token died the moment this
          // response was minted. Persist the replacement BEFORE the remaining
          // fallible steps, or a verify hiccup would strand the account with a
          // dead token and the next retry would kill the whole family. The
          // presence-check → persist segment is uninterruptible so even the
          // pathological flight-scope teardown cannot separate a committed
          // rotation from its persisted secret — every step inside the mask
          // is local and fast; the network reads stay OUTSIDE it, so a wedged
          // socket can never become an unkillable fiber past quit's deadline.
          // A response without refresh_token keeps the old one (policy contract).
          const presentAtPersist = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const present =
                (yield* SubscriptionRef.get(sessionState)).accounts[sub] !== undefined;
              if (rotated !== null && present) {
                // A store failure HERE is NOT 'transient': a backoff retry
                // would re-read and replay the dead old token. Re-attempt the
                // persist immediately (bounded); continued failure is
                // definitive for this account ('persist-failed' → drop).
                yield* secureStore.setSecret(refreshTokenKey(sub), rotated).pipe(
                  Effect.retry({ times: 2 }),
                  Effect.mapError(cause => new RefreshError({ reason: 'persist-failed', cause }))
                );
              }
              return present;
            })
          ).pipe(
            Effect.tapError(() =>
              // The rotation minted a token we failed to take custody of —
              // revoke it best-effort (outside the mask: a network call must
              // never run uninterruptibly) before the definitive drop.
              rotated === null ? Effect.void : revokeToken(rotated).pipe(Effect.ignore)
            )
          );
          const identity = yield* validateIdToken(parsed.value.idToken).pipe(
            Effect.mapError(cause => new RefreshError({ reason: 'verification', cause }))
          );
          if (identity.sub !== sub) {
            return yield* Effect.fail(
              new RefreshError({ reason: 'verification', cause: 'sub-mismatch' })
            );
          }
          const presentAtCommit =
            (yield* SubscriptionRef.get(sessionState)).accounts[sub] !== undefined;
          if (!presentAtCommit) {
            // Signed out mid-flight — a late refresh must not resurrect the
            // account. The just-minted refresh token
            // must not linger live server-side either (signOut revoked only
            // the consumed OLD token): revoke it best-effort, and scrub the
            // secret if this flight persisted it after signOut's wipe.
            if (rotated !== null) {
              yield* revokeToken(rotated).pipe(Effect.ignore);
              if (presentAtPersist) {
                yield* secureStore
                  .deleteSecret(refreshTokenKey(sub))
                  .pipe(Effect.catchAll(cause => log.error('secret wipe failed', { error: cause })));
              }
            }
            return yield* Effect.fail(
              new RefreshError({ reason: 'transient', cause: 'account-removed' })
            );
          }
          yield* Ref.update(tokensRef, map =>
            new Map(map).set(sub, {
              idToken: parsed.value.idToken,
              accessToken: parsed.value.accessToken,
              expiresAt: parsed.value.expiresAt,
            })
          );
          yield* Ref.update(retryRef, map => {
            const next = new Map(map);
            next.delete(sub);
            return next;
          });
          yield* SubscriptionRef.update(sessionState, state =>
            applyRefreshedIdentity(state, identity)
          );
          yield* persistIndexLogged;
          yield* log.info('refresh complete', { context: { sub: subPrefix(sub) } });
          return parsed.value.idToken;
        });

      /**
       * The single-flight Deferred must settle with a TYPED exit: forwarding a
       * defect (or the pathological teardown interrupt) verbatim would resume
       * awaiters with a cause their Effect.catchAll cannot handle and kill the
       * scheduler/resume/focus loops permanently.
       */
      const coerceFlightExit = (
        exit: Exit.Exit<string, RefreshError>
      ): Exit.Exit<string, RefreshError> =>
        Exit.match(exit, {
          onSuccess: () => exit,
          onFailure: cause =>
            Option.match(Cause.failureOption(cause), {
              onSome: () => exit,
              onNone: () => Exit.fail(new RefreshError({ reason: 'transient', cause })),
            }),
        });

      /**
       * Single flight: rotation has zero grace — two concurrent refreshes with
       * the same token trip `invalidateRefreshFamily` and kill every install of
       * the user. Whoever installs the Deferred forks the one HTTP
       * call into the layer-owned flight scope — the flight never runs on a
       * caller's fiber, so caller interruption only abandons the await, never
       * the flight. The install→fork window is masked so an interrupt cannot
       * strand an installed, never-settled Deferred.
       */
      const refreshAccount = (sub: string): Effect.Effect<string, RefreshError> =>
        Effect.uninterruptibleMask(restore =>
          Effect.gen(function* () {
            const deferred = yield* Deferred.make<string, RefreshError>();
            const winner = yield* Ref.modify(inflightRef, map => {
              const existing = map.get(sub);
              if (existing !== undefined) return [existing, map] as const;
              return [deferred, new Map(map).set(sub, deferred)] as const;
            });
            if (winner === deferred) {
              // The fork happens INSIDE the mask (an interrupt must not strand
              // an installed, never-settled Deferred) — but a forked child
              // inherits the parent's UNINTERRUPTIBLE flag, which would make
              // TOKEN_REQUEST_TIMEOUT unable to abort a hung socket: the
              // timeout's internal interrupt would park until the fetch
              // settled (never), wedging the deferred — and with it every
              // caller for this sub — for the process lifetime.
              // So the flight BODY is explicitly interruptible; the rotate→
              // persist window keeps its own mask inside runRefresh, and the
              // settle/Deferred.done tail below stays uninterruptible.
              yield* Effect.interruptible(runRefresh(sub)).pipe(
                Effect.tapError(error => settleRefreshFailure(sub, error)),
                Effect.onExit(exit =>
                  Ref.update(inflightRef, map => {
                    const next = new Map(map);
                    next.delete(sub);
                    return next;
                  }).pipe(Effect.zipRight(Deferred.done(deferred, coerceFlightExit(exit))))
                ),
                Effect.forkIn(flightScope)
              );
            }
            return yield* restore(Deferred.await(winner));
          })
        );

      const markRefreshingIfActive = (sub: string): Effect.Effect<void> =>
        SubscriptionRef.update(sessionState, state =>
          state.activeSub === sub && state.gate === 'signed-in'
            ? { ...state, gate: 'refreshing' as const }
            : state
        );

      // ----- refresh scheduling ------------------------------------------------

      /** Refresh every account whose token sits inside the skew window. */
      const refreshDueAccounts = (ignoreBackoff: boolean): Effect.Effect<void> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const state = yield* SubscriptionRef.get(sessionState);
          const tokens = yield* Ref.get(tokensRef);
          const retries = yield* Ref.get(retryRef);
          const due = Object.keys(state.accounts).filter(sub => {
            const set = tokens.get(sub);
            // Token-less accounts (restored, non-active) refresh on demand.
            if (set === undefined) return false;
            if (set.expiresAt - now > EXPIRY_SKEW_MS) return false;
            const retry = retries.get(sub);
            return ignoreBackoff || retry === undefined || retry.at <= now;
          });
          yield* Effect.forEach(
            due,
            sub =>
              markRefreshingIfActive(sub).pipe(
                Effect.zipRight(refreshAccount(sub)),
                Effect.catchAll(error =>
                  log.warn('scheduled refresh failed', { context: {
                    sub: subPrefix(sub),
                    reason: error.reason,
                  } })
                )
              ),
            { discard: true }
          );
        });

      const schedulerStep: Effect.Effect<void> = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const state = yield* SubscriptionRef.get(sessionState);
        const tokens = yield* Ref.get(tokensRef);
        const retries = yield* Ref.get(retryRef);
        const dues = Object.keys(state.accounts).flatMap(sub => {
          const set = tokens.get(sub);
          if (set === undefined) return [];
          const retry = retries.get(sub);
          return [Math.max(set.expiresAt - EXPIRY_SKEW_MS, retry?.at ?? 0)];
        });
        const next = dues.length === 0 ? undefined : Math.min(...dues);
        // The floor guards short-TTL tokens (lifetime ≤ skew ⇒ next is always
        // in the past): the loop paces at 1 s instead of storming the endpoint.
        const sleepMs =
          next === undefined
            ? Duration.toMillis(SCHEDULER_IDLE_POLL)
            : Math.max(next - now, SCHEDULER_MIN_SLEEP_MS);
        yield* Effect.sleep(Duration.millis(sleepMs));
        yield* refreshDueAccounts(false);
      });

      // Background auth loops must be immortal: a defecting step is logged and
      // the loop continues — a dead scheduler would silently stop proactive
      // refresh for the rest of the process. External interruption (scope
      // close) still passes through, so quit is never blocked.
      const immortal = (label: string, step: Effect.Effect<unknown>): Effect.Effect<never> =>
        Effect.forever(
          step.pipe(
            Effect.catchAllCause(cause =>
              Cause.isInterruptedOnly(cause)
                ? Effect.failCause(cause)
                : log.error(`${label} step failed — loop continues`, { error: Cause.squash(cause) })
            )
          )
        );

      yield* Effect.forkScoped(immortal('refresh scheduler', schedulerStep));

      // Sleep/lid transitions skew wall-clock past expiry without the sleeping
      // fiber noticing; window focus is the cheap "user is back" signal. Both
      // force a due-check with backoff cleared (the network likely changed).
      yield* Effect.forkScoped(
        immortal(
          'power-resume watcher',
          Queue.take(electronApp.events.powerResume).pipe(Effect.zipRight(refreshDueAccounts(true)))
        )
      );
      yield* Effect.forkScoped(
        immortal(
          'focus watcher',
          Queue.take(windows.windowEvents).pipe(
            Effect.flatMap(event =>
              event._tag === 'focused' ? refreshDueAccounts(true) : Effect.void
            )
          )
        )
      );

      // Restart-restores-securely: eagerly re-obtain tokens for the active
      // account from its safeStorage refresh token. Forked — boot never blocks
      // on the network; a transient failure lands on 'offline', NOT signed-out.
      if (restored.activeSub !== undefined) {
        const activeSub = restored.activeSub;
        yield* Effect.forkScoped(
          refreshAccount(activeSub).pipe(
            Effect.catchAll(error =>
              log.warn('restore refresh failed', { context: { sub: subPrefix(activeSub), reason: error.reason } })
            )
          )
        );
      }

      // ----- public API ---------------------------------------------------------

      const launchSignInFlow = (opts?: {
        readonly promptLogin?: boolean;
      }): Effect.Effect<void, AuthFlowError> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const pkce = makePkceMaterial(random);
          // Replace-don't-block: a user-driven signIn replaces any
          // parked attempt — fresh verifier/state, browser relaunched. The
          // stale tab's late callback then fails the state match and is
          // rejected and counted; still exactly one pending slot, and no
          // 10-minute lockout after an abandoned browser dance.
          yield* Ref.set(attemptRef, launchAttempt(pkce, now));
          const url = buildAuthorizeUrl({
            authorizeUrl: config.auth.authorizeUrl,
            clientId: config.auth.oauthClientId,
            redirectUri: config.auth.redirectUri,
            challenge: pkce.challenge,
            state: pkce.state,
            promptLogin: opts?.promptLogin === true,
          });
          if (!isAllowedExternalUrl(url)) {
            // Config-injection guard — same protocol allowlist as the windows
            // navigation boundary.
            yield* Ref.set(attemptRef, idleAttempt);
            return yield* Effect.fail(
              new AuthFlowError({
                reason: 'browser-launch-failed',
                cause: 'authorize URL rejected by the external-protocol allowlist',
              })
            );
          }
          if (config.isE2E) {
            // E2E guard: tests never open a real browser — the fake IdP path
            // delivers the callback via emitted open-url events.
            yield* log.info('browser launch skipped (E2E)', { context: { state: statePrefix(pkce.state) } });
          } else {
            yield* Effect.tryPromise({
              try: () => shell.openExternal(url),
              catch: cause => new AuthFlowError({ reason: 'browser-launch-failed', cause }),
            }).pipe(Effect.tapError(() => Ref.set(attemptRef, idleAttempt)));
          }
          yield* SubscriptionRef.update(sessionState, state =>
            state.gate === 'signed-out' || state.gate === 'offline'
              ? { ...state, gate: 'signing-in' as const }
              : state
          );
          yield* log.info('sign-in flow launched', { context: { state: statePrefix(pkce.state) } });
        });

      const signIn: AuthApi['signIn'] = opts =>
        Effect.gen(function* () {
          if (config.auth.oauthClientId === '') {
            // '' is the "not configured" placeholder — boot stays clean, the
            // failure surfaces here as NOT_CONFIGURED.
            return yield* Effect.fail(new AuthFlowError({ reason: 'not-configured' }));
          }
          // Two CONCURRENT invokes must produce one attempt + one browser
          // launch: claim the in-flight slot for the (sub-second) launch
          // window. This guard is the ONLY remaining source of
          // 'flow-already-pending' — a sequential retry always succeeds.
          const claimed = yield* Ref.modify(signInInFlightRef, busy =>
            busy ? ([false, true] as const) : ([true, true] as const)
          );
          if (!claimed) {
            return yield* Effect.fail(new AuthFlowError({ reason: 'flow-already-pending' }));
          }
          return yield* launchSignInFlow(opts).pipe(
            Effect.ensuring(Ref.set(signInInFlightRef, false))
          );
        });

      /**
       * A failed attempt/exchange leaves 'signing-in'; the fallback is what
       * the account set implies (an active account keeps
       * its live session — resetting to 'signed-out' would tear down a valid
       * SignedInRuntime and stick there, since only 'refreshing'/'offline'
       * promote back on refresh). 'signed-out' only when no account remains.
       */
      const revertSigningInGate: Effect.Effect<void> = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const tokens = yield* Ref.get(tokensRef);
        yield* SubscriptionRef.update(sessionState, state => {
          if (state.gate !== 'signing-in') return state;
          const active = state.activeSub === undefined ? undefined : state.accounts[state.activeSub];
          if (active === undefined) return { ...state, gate: 'signed-out' as const };
          const set = tokens.get(active.sub);
          const hasValidToken = set !== undefined && set.expiresAt > now;
          return { ...state, gate: hasValidToken ? ('signed-in' as const) : ('offline' as const) };
        });
      });

      const consumePendingEntry = (
        entry: PendingOAuthEntry
      ): Effect.Effect<PendingEntryVerdict> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (entry._tag === 'OAuthError') {
            const errorState = entry.state;
            if (errorState === undefined) {
              // RFC 6749 echoes state only when sent — we ALWAYS send one, so
              // an error without state cannot be tied to our attempt.
              yield* log.warn('oauth error without state rejected', { error: entry.error });
              return 'rejected' as const;
            }
            const matched = yield* Ref.modify(
              attemptRef,
              (attempt): readonly [AttemptMatch['_tag'], AuthAttempt] => {
                const match = matchAttempt(attempt, errorState, now);
                // Consume and Expired both clear the slot; only Consume fails the flow.
                return match._tag === 'Reject' ? [match._tag, attempt] : [match._tag, idleAttempt];
              }
            );
            if (matched === 'Consume') {
              yield* revertSigningInGate;
              yield* log.warn('sign-in attempt failed — provider error', { context: { description: entry.errorDescription, state: statePrefix(errorState) }, error: entry.error });
              return 'attempt-failed' as const;
            }
            yield* log.warn('oauth error rejected — no matching attempt', { context: { state: statePrefix(errorState) }, error: entry.error });
            return 'rejected' as const;
          }

          const match = yield* Ref.modify(
            attemptRef,
            (attempt): readonly [AttemptMatch, AuthAttempt] => {
              const result = matchAttempt(attempt, entry.state, now);
              // Consumed exactly once: a matching state empties the slot even
              // when expired, so a duplicate can never race a second exchange.
              return result._tag === 'Reject' ? [result, attempt] : [result, idleAttempt];
            }
          );
          switch (match._tag) {
            case 'Consume':
              return yield* completeExchange(entry.code, match.verifier).pipe(
                Effect.as('exchanged' as const),
                Effect.catchAll(error =>
                  Effect.gen(function* () {
                    yield* revertSigningInGate;
                    if (error._tag === 'SecureStoreError' || error._tag === 'DbError') {
                      // Exchange + verify SUCCEEDED — only the local commit
                      // failed (the minted refresh token was revoked
                      // best-effort inside completeExchange). Never misreport
                      // an upstream success as an exchange failure.
                      yield* log.error('sign-in could not be committed locally — flow must restart', { context: { reason: 'reason' in error ? error.reason : undefined }, error: error._tag });
                      return 'persist-failed' as const;
                    }
                    // Codes are single-use (600 s TTL): a failed exchange
                    // restarts the whole flow, never retries the code.
                    yield* log.error('oauth exchange failed — flow must restart', { context: { reason: 'reason' in error ? error.reason : undefined }, error: error._tag });
                    return 'exchange-failed' as const;
                  })
                )
              );
            case 'Expired':
              yield* log.warn('oauth callback rejected — attempt expired', { context: {
                state: statePrefix(entry.state),
              } });
              return 'rejected' as const;
            case 'Reject':
              yield* log.warn('oauth callback rejected — no matching attempt', { context: {
                state: statePrefix(entry.state),
              } });
              return 'rejected' as const;
          }
        });

      const getIdToken: AuthApi['getIdToken'] = sub =>
        Effect.gen(function* () {
          const state = yield* SubscriptionRef.get(sessionState);
          const target = sub ?? state.activeSub;
          if (target === undefined) {
            return yield* Effect.fail(new AuthStateError({ reason: 'no-active-account' }));
          }
          if (state.accounts[target] === undefined) {
            return yield* Effect.fail(new AuthStateError({ reason: 'unknown-account' }));
          }
          const now = yield* Clock.currentTimeMillis;
          const tokens = (yield* Ref.get(tokensRef)).get(target);
          if (tokens !== undefined && tokens.expiresAt - now > EXPIRY_SKEW_MS) {
            return tokens.idToken;
          }
          yield* markRefreshingIfActive(target);
          return yield* refreshAccount(target);
        });

      const openWebSession: AuthApi['openWebSession'] = (returnPath, activeOrgId) =>
        Effect.gen(function* () {
          if (!SAFE_WEB_RETURN_PATH.test(returnPath)) {
            return yield* Effect.fail(
              new WebSessionHandoffError({ reason: 'invalid-return' })
            );
          }

          const idToken = yield* getIdToken();
          const endpoint = new URL(
            '/api/auth/handoff/web-session',
            config.endpoints.coreApiUrl
          ).toString();
          const response = yield* postJson(
            endpoint,
            { return: returnPath, ...(activeOrgId ? { activeOrgId } : {}) },
            WEB_HANDOFF_TIMEOUT,
            { authorization: `Bearer ${idToken}` }
          ).pipe(
            Effect.mapError(
              failure =>
                new WebSessionHandoffError(
                  failure.kind === 'timeout'
                    ? { reason: 'timeout' }
                    : { reason: 'network', cause: failure.cause }
                )
            )
          );
          if (!response.ok) {
            return yield* Effect.fail(
              new WebSessionHandoffError({ reason: 'http', status: response.status })
            );
          }

          const body = yield* readJson(
            response,
            cause => new WebSessionHandoffError({ reason: 'invalid-response', cause })
          );
          const rawUrl =
            typeof body === 'object' && body !== null && typeof (body as { url?: unknown }).url === 'string'
              ? (body as { url: string }).url
              : null;
          if (rawUrl === null) {
            return yield* Effect.fail(
              new WebSessionHandoffError({ reason: 'invalid-response' })
            );
          }

          let url: URL;
          try {
            url = new URL(rawUrl);
          } catch (cause) {
            return yield* Effect.fail(
              new WebSessionHandoffError({ reason: 'invalid-response', cause })
            );
          }
          const expectedOrigin = new URL(config.endpoints.webAppOrigin).origin;
          if (!isAllowedWebHandoffUrl(url, expectedOrigin)) {
            return yield* Effect.fail(new WebSessionHandoffError({ reason: 'unsafe-url' }));
          }

          if (config.isE2E) {
            yield* log.info('web handoff browser launch skipped (E2E)', { context: { returnPath } });
          } else {
            yield* Effect.tryPromise({
              try: () => shell.openExternal(url.toString()),
              catch: cause =>
                new WebSessionHandoffError({ reason: 'browser-launch-failed', cause }),
            });
          }
        });

      const signOut: AuthApi['signOut'] = sub =>
        Effect.gen(function* () {
          const state = yield* SubscriptionRef.get(sessionState);
          const target = sub ?? state.activeSub;
          if (target === undefined || state.accounts[target] === undefined) return;
          // Leave live state FIRST so an in-flight refresh cannot resurrect the
          // account or re-persist a rotated secret (guards in runRefresh).
          yield* SubscriptionRef.update(sessionState, current => dropAccount(current, target));
          yield* Ref.update(tokensRef, map => {
            const next = new Map(map);
            next.delete(target);
            return next;
          });
          yield* Ref.update(retryRef, map => {
            const next = new Map(map);
            next.delete(target);
            return next;
          });
          // Rewrite the persisted index NEXT — it is what resurrects accounts
          // on boot, so it must not wait behind fallible revoke/wipe steps.
          // Bounded retry, then degrade loudly: post-revoke, a one-boot
          // resurrection self-heals (the eager restore refresh 401s → drop).
          yield* persistIndex.pipe(
            Effect.retry({ times: 2 }),
            Effect.catchAll(cause =>
              log.error('sign-out could not rewrite the account index — may resurrect once', { error: cause })
            )
          );
          // Server-side revocation kills the refresh token and its
          // child opaque access tokens; JWTs run out their ≤10 h exp. Best-effort
          // and bounded — local sign-out never hangs on the network.
          const secret = yield* secureStore
            .getSecret(refreshTokenKey(target))
            .pipe(Effect.catchAll(() => Effect.succeed(null)));
          if (secret !== null) {
            yield* revokeToken(secret).pipe(
              Effect.catchAll(error =>
                log.warn('revoke failed (best-effort)', { context: {
                  reason: error.reason,
                  status: error.status,
                } })
              )
            );
          }
          // Deliberately NOT calling POST /api/auth/sign-out: the SSO cookie
          // lives in the system browser, so a cookie-less main-process fetch is
          // misleading noise — an accepted limitation.
          yield* secureStore.deleteSecret(refreshTokenKey(target)).pipe(
            Effect.retry({ times: 2 }),
            Effect.catchAll(cause =>
              // Index-less (removed above), so it can never resurrect an
              // account — but encrypted ciphertext lingers on disk. Loud and
              // greppable; the invoke still resolves (state is already gone,
              // and a rejected invoke would offer a retry that must no-op
              // against the idempotency guard).
              log.error('sign-out left an orphaned refresh-token secret on disk', { context: { key: refreshTokenKey(target) }, error: cause })
            )
          );
          yield* log.info('signed out', { context: { sub: subPrefix(target) } });
        });

      const setActiveAccount: AuthApi['setActiveAccount'] = sub =>
        Effect.gen(function* () {
          const state = yield* SubscriptionRef.get(sessionState);
          if (state.accounts[sub] === undefined) {
            return yield* Effect.fail(new AuthStateError({ reason: 'unknown-account' }));
          }
          yield* SubscriptionRef.update(sessionState, current => ({
            ...current,
            activeSub: sub,
            gate: 'signed-in' as const,
          }));
          yield* persistIndex;
        });

      const setActiveOrg: AuthApi['setActiveOrg'] = orgId =>
        Effect.gen(function* () {
          const state = yield* SubscriptionRef.get(sessionState);
          const active = state.activeSub === undefined ? undefined : state.accounts[state.activeSub];
          if (active === undefined) {
            return yield* Effect.fail(new AuthStateError({ reason: 'no-active-account' }));
          }
          // Validated against the verified org_users claim; the server re-resolves
          // membership per request regardless.
          //
          // A claim MISS is not proof of non-membership though — it can simply mean the
          // token predates the membership. That is the norm, not an edge case: creating an
          // organization and accepting an invitation both make the caller a member
          // server-side and then immediately switch to it, and the id_token in hand was
          // minted before either existed. Failing outright made both silently no-op (the
          // renderer's port is fire-and-forget), stranding the user on the PREVIOUS org
          // while the UI reported success. So on a miss, refresh ONCE and re-check: the
          // refresh re-mints org_users from current membership (accountFromIdentity), which
          // is exactly the question being asked. Only a miss that survives a fresh token is
          // a real rejection.
          //
          // Goes through refreshAccount, never runRefresh: rotation has zero grace, so a
          // raw call racing the scheduler would trip invalidateRefreshFamily and sign the
          // user out everywhere. Bounded at one attempt per call — a caller passing garbage
          // org ids costs one token-endpoint round trip each, and concurrent ones collapse
          // into the single flight.
          const isMember = (accounts: AuthState['accounts']): boolean =>
            accounts[active.sub]?.orgs.some(org => org.orgId === orgId) === true;
          if (orgId !== null && !isMember(state.accounts)) {
            yield* log.info('setActiveOrg: org absent from claim, refreshing once', { context: {
              sub: subPrefix(active.sub),
            } });
            const refreshed = yield* refreshAccount(active.sub).pipe(
              Effect.as(true),
              // A refresh failure leaves membership unproven, which is the same answer as
              // a miss — but log the real cause so it isn't misread as "not a member".
              Effect.catchAll(cause =>
                log.warn('setActiveOrg: refresh failed, cannot confirm membership', { context: {
                  reason: cause.reason,
                } }).pipe(Effect.as(false))
              )
            );
            const after = yield* SubscriptionRef.get(sessionState);
            if (!refreshed || !isMember(after.accounts)) {
              return yield* Effect.fail(new AuthStateError({ reason: 'invalid-org' }));
            }
          }
          yield* SubscriptionRef.update(sessionState, current =>
            setAccountOrg(current, active.sub, orgId)
          );
          yield* persistIndex;
        });

      yield* log.info('auth service ready', { context: {
        configured: config.auth.oauthClientId !== '',
        restoredAccounts: Object.keys(restored.accounts).length,
      } });

      // e2e:authPendingState seam: state param only — the verifier never leaves
      // attemptRef (the specs assert the exchange body carries it instead).
      const pendingAttemptState: AuthApi['pendingAttemptState'] = Ref.get(attemptRef).pipe(
        Effect.map(attempt => (attempt._tag === 'Launched' ? attempt.state : null))
      );
      const pendingAttemptAuthorizeUrl: AuthApi['pendingAttemptAuthorizeUrl'] = Ref.get(
        attemptRef
      ).pipe(
        Effect.map(attempt =>
          attempt._tag === 'Launched'
            ? buildAuthorizeUrl({
                authorizeUrl: config.auth.authorizeUrl,
                clientId: config.auth.oauthClientId,
                redirectUri: config.auth.redirectUri,
                challenge: challengeForVerifier(attempt.verifier),
                state: attempt.state,
                promptLogin: false,
              })
            : null
        )
      );

      const service: AuthApi = {
        sessionState,
        signIn,
        signOut,
        setActiveAccount,
        setActiveOrg,
        getIdToken,
        openWebSession,
        consumePendingEntry,
        pendingAttemptState,
        pendingAttemptAuthorizeUrl,
      };
      return service;
    })
  );

export const AuthServiceLive = makeAuthLive();
