import { Context, Data, type Effect, type SubscriptionRef } from 'effect';
import type { DbError } from '../../infra/operational-db/service';
import type { PendingOAuthEntry } from '../deep-link/service';
import type { AuthState, IdentityParseFailure } from './policy';

/**
 * Flow-start failures. Reasons map 1:1 onto signInResultSchema codes
 * (NOT_CONFIGURED / FLOW_ALREADY_PENDING / BROWSER_LAUNCH_FAILED); the IPC
 * handler does the mapping. 'flow-already-pending' is kept for wire compat but
 * is only reachable from CONCURRENT signIn invokes (the launch window is
 * single-flighted); a sequential user retry REPLACES the parked attempt
 * instead of failing, which avoids a 10-minute lockout.
 */
export class AuthFlowError extends Data.TaggedError('AuthFlowError')<{
  readonly reason: 'not-configured' | 'flow-already-pending' | 'browser-launch-failed';
  readonly cause?: unknown;
}> {}

export class TokenExchangeError extends Data.TaggedError('TokenExchangeError')<{
  readonly reason: 'http' | 'network' | 'timeout' | 'invalid-response';
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export class TokenVerificationError extends Data.TaggedError('TokenVerificationError')<{
  readonly reason: IdentityParseFailure;
  readonly cause?: unknown;
}> {}

/**
 * 'revoked', 'no-refresh-token' and 'persist-failed' are DEFINITIVE — the
 * account is dropped and the refresh is never retried. 'persist-failed': a
 * rotation response arrived but its replacement token could not be persisted;
 * the OLD token is already dead server-side (zero grace) and the NEW one was
 * revoked best-effort, so nothing remains to retry WITH — retrying would
 * replay the dead token and kill the whole refresh-token family. 'transient'
 * (network/5xx/timeout) and 'verification' keep the account; retries back off.
 */
export class RefreshError extends Data.TaggedError('RefreshError')<{
  readonly reason: 'revoked' | 'no-refresh-token' | 'persist-failed' | 'transient' | 'verification';
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export class RevokeError extends Data.TaggedError('RevokeError')<{
  readonly reason: 'http' | 'network' | 'timeout';
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export class WebSessionHandoffError extends Data.TaggedError('WebSessionHandoffError')<{
  readonly reason:
    | 'invalid-return'
    | 'http'
    | 'network'
    | 'timeout'
    | 'invalid-response'
    | 'unsafe-url'
    | 'browser-launch-failed';
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export class AuthStateError extends Data.TaggedError('AuthStateError')<{
  readonly reason: 'unknown-account' | 'no-active-account' | 'invalid-org';
}> {}

/** How the auth domain settled one parked deep-link entry for consumer logging. */
export type PendingEntryVerdict =
  /** Attempt consumed, exchange+verify+persist succeeded. */
  | 'exchanged'
  /** Attempt consumed but the pipeline failed — the whole flow restarts (codes are single-use). */
  | 'exchange-failed'
  /**
   * Exchange + verify SUCCEEDED but the account could not be committed locally
   * (secret-store failure); the minted refresh token was revoked best-effort
   * and the flow restarts. Distinct from 'exchange-failed' so logs never
   * misreport an upstream success as an exchange failure.
   */
  | 'persist-failed'
  /** Provider error redirect matched the attempt — definitive flow failure. */
  | 'attempt-failed'
  /** Unknown/expired/duplicate state — removed and counted, never exchanged. */
  | 'rejected';

export interface AuthApi {
  /**
   * Observable session state. Tokens NEVER appear here (they live in a private
   * in-memory Ref); the lifecycle loop and sessionChanged push both
   * derive from this ref (policy.toSessionView projects onto the IPC schema).
   */
  readonly sessionState: SubscriptionRef.SubscriptionRef<AuthState>;
  /**
   * Starts the PKCE flow in the system browser. Resolves at flow-START;
   * completion travels via sessionState (auth:sessionChanged).
   */
  readonly signIn: (opts?: { readonly promptLogin?: boolean }) => Effect.Effect<void, AuthFlowError>;
  /**
   * Revoke (best-effort, bounded) + wipe secret + drop from state/index.
   * Idempotent and INFALLIBLE: live state leaves first, then the persisted
   * index (kills restart-resurrection), then revoke + secret wipe — local
   * storage failures degrade to bounded retries + loud logs, so the invoke
   * always resolves truthfully with what the renderer already sees.
   */
  readonly signOut: (sub?: string) => Effect.Effect<void>;
  readonly setActiveAccount: (sub: string) => Effect.Effect<void, AuthStateError | DbError>;
  /** Org pick for the ACTIVE account, validated against its org_users claim. */
  readonly setActiveOrg: (orgId: string | null) => Effect.Effect<void, AuthStateError | DbError>;
  /**
   * A currently-valid id_token for the account (default: active), transparently
   * refreshed (single-flight) inside the expiry skew. The transport and
   * collab broker hand-off use this seam.
   */
  readonly getIdToken: (sub?: string) => Effect.Effect<string, RefreshError | AuthStateError>;
  /**
   * Exchange the active native identity for a short-lived browser handoff URL,
   * then open it in the system browser. The id_token never crosses into the
   * renderer; Core verifies it and the web app completes its own PKCE flow.
   */
  readonly openWebSession: (
    returnPath: string,
    activeOrgId?: string
  ) => Effect.Effect<
    void,
    RefreshError | AuthStateError | WebSessionHandoffError
  >;
  /**
   * Main-internal: the deep-link consumer feeds parked oauth entries here.
   * Never fails — every outcome is a verdict so the consumer fiber cannot die.
   */
  readonly consumePendingEntry: (entry: PendingOAuthEntry) => Effect.Effect<PendingEntryVerdict>;
  /**
   * Test-only observability seam (e2e:authPendingState — the IPC channel is
   * registered ONLY under PRISMICAL_E2E, mirroring StreamBroker.stats): the
   * parked attempt's `state` param, null when the slot is idle. Deliberately
   * NEVER the verifier — that secret stays inside the live layer's Ref.
   */
  readonly pendingAttemptState: Effect.Effect<string | null>;
  /**
   * Test-only public authorize URL for the parked PKCE attempt. The challenge
   * and state are browser-facing OAuth values; the verifier remains in MAIN.
   */
  readonly pendingAttemptAuthorizeUrl: Effect.Effect<string | null>;
}

export class AuthService extends Context.Tag('desktop/Auth')<AuthService, AuthApi>() {}
