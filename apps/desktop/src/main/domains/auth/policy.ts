/**
 * Pure OAuth/PKCE policy.
 * No electron import; randomness is injected so tests drive fixed vectors
 * (node:crypto supplies it at the live edge). Table-driven tests in
 * tests/policy/auth.test.ts.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import type { SessionGateState, SessionView } from '@prismical/desktop-contracts';

export const OAUTH_SCOPE = 'openid profile email offline_access';

/**
 * Attempt lifetime: authorize codes live 600 s server-side; the local attempt
 * expires on the same horizon so a stale callback can never exchange.
 */
export const ATTEMPT_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// PKCE material (RFC 7636; mirrors the web client)
// ---------------------------------------------------------------------------

export type RandomSource = (byteLength: number) => Uint8Array;

export interface PkceMaterial {
  readonly verifier: string;
  readonly challenge: string;
  readonly state: string;
}

export const challengeForVerifier = (verifier: string): string =>
  createHash('sha256').update(verifier).digest().toString('base64url');

/** verifier = base64url(32 random bytes); challenge = base64url(SHA-256(verifier)); state = base64url(16 random bytes). */
export const makePkceMaterial = (random: RandomSource): PkceMaterial => {
  const verifier = Buffer.from(random(32)).toString('base64url');
  const challenge = challengeForVerifier(verifier);
  const state = Buffer.from(random(16)).toString('base64url');
  return { verifier, challenge, state };
};

export interface AuthorizeUrlOptions {
  readonly authorizeUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly state: string;
  /** Forces the login form for an add-account flow. */
  readonly promptLogin: boolean;
}

/** Same construction as the web client (auth-context.tsx signIn) — core accepts it verbatim. */
export const buildAuthorizeUrl = (options: AuthorizeUrlOptions): string => {
  const url = new URL(options.authorizeUrl);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', OAUTH_SCOPE);
  url.searchParams.set('code_challenge', options.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', options.state);
  if (options.promptLogin) url.searchParams.set('prompt', 'login');
  return url.toString();
};

// ---------------------------------------------------------------------------
// Attempt lifecycle (one pending slot, consumed exactly once)
// ---------------------------------------------------------------------------

export type AuthAttempt =
  | { readonly _tag: 'Idle' }
  | {
      readonly _tag: 'Launched';
      readonly verifier: string;
      readonly state: string;
      readonly expiresAt: number;
    };

export const idleAttempt: AuthAttempt = { _tag: 'Idle' };

export const launchAttempt = (pkce: PkceMaterial, now: number): AuthAttempt => ({
  _tag: 'Launched',
  verifier: pkce.verifier,
  state: pkce.state,
  expiresAt: now + ATTEMPT_TTL_MS,
});

export type AttemptMatch =
  /** Live attempt, matching state — consume it (the slot transitions to Idle). */
  | { readonly _tag: 'Consume'; readonly verifier: string }
  /** Matching state but the attempt expired — definitive reject, never exchange. */
  | { readonly _tag: 'Expired' }
  /** No live attempt or a different state — reject and count. */
  | { readonly _tag: 'Reject' };

/**
 * Constant-time comparison so callback handling cannot probe the pending state
 * byte-by-byte.
 */
export const constantTimeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Equal-length self-compare keeps the work independent of where they differ.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
};

/** Wrong/expired/duplicate state must never trigger a token exchange. */
export const matchAttempt = (attempt: AuthAttempt, state: string, now: number): AttemptMatch => {
  if (attempt._tag === 'Idle') return { _tag: 'Reject' };
  if (!constantTimeEqual(attempt.state, state)) return { _tag: 'Reject' };
  if (now >= attempt.expiresAt) return { _tag: 'Expired' };
  return { _tag: 'Consume', verifier: attempt.verifier };
};

// ---------------------------------------------------------------------------
// Token response parsing
// ---------------------------------------------------------------------------

export interface ParsedTokenResponse {
  readonly accessToken: string;
  readonly idToken: string;
  /** null ⇒ the server omitted rotation — the caller KEEPS the old refresh token. */
  readonly refreshToken: string | null;
  /** Absolute epoch ms. expires_in wins; the id_token's own exp is the fallback. */
  readonly expiresAt: number;
}

export type TokenResponseParse =
  | { readonly ok: true; readonly value: ParsedTokenResponse }
  | { readonly ok: false; readonly issue: string };

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    id_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    // May arrive as number or string; the web parser handles both.
    expires_in: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

const toSeconds = (value: number | string | undefined): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * Best-effort exp (epoch ms) from a JWT payload. Expiry fallback ONLY — claims
 * used as identity go through parseIdToken, never this.
 */
export const decodeJwtExpiryMs = (jwt: string): number | null => {
  const segments = jwt.split('.');
  if (segments.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as unknown;
    if (payload === null || typeof payload !== 'object') return null;
    const exp = (payload as Record<string, unknown>)['exp'];
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
};

export const parseTokenResponse = (body: unknown, now: number): TokenResponseParse => {
  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success) {
    // Issue paths only — never token values.
    return { ok: false, issue: parsed.error.issues.map(issue => issue.path.join('.')).join(',') };
  }
  const seconds = toSeconds(parsed.data.expires_in);
  const expiresAt = seconds !== null ? now + seconds * 1000 : decodeJwtExpiryMs(parsed.data.id_token);
  if (expiresAt === null) return { ok: false, issue: 'no-expiry' };
  return {
    ok: true,
    value: {
      accessToken: parsed.data.access_token,
      idToken: parsed.data.id_token,
      refreshToken: parsed.data.refresh_token ?? null,
      expiresAt,
    },
  };
};

// ---------------------------------------------------------------------------
// ID token claims from the configured token endpoint.
// ---------------------------------------------------------------------------

export interface OrgMembership {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
}

export interface IdTokenIdentity {
  readonly sub: string;
  readonly email: string;
  readonly name?: string;
  readonly signupAt?: string;
  readonly orgs: ReadonlyArray<OrgMembership>;
}

export type IdentityParseFailure =
  | 'invalid-token'
  | 'invalid-claims'
  | 'expired'
  | 'missing-sub'
  | 'not-first-party'
  | 'missing-email'
  | 'malformed-org-users';

export type IdentityParse =
  | { readonly ok: true; readonly value: IdTokenIdentity }
  | { readonly ok: false; readonly reason: IdentityParseFailure };

const orgUsersClaimSchema = z.array(
  z
    .object({
      id: z.string().min(1),
      org_id: z.string().min(1),
      user_id: z.string().min(1),
    })
    .passthrough()
);

/** Validate claims from the token endpoint response; HTTPS authenticates that response. */
export const parseIdToken = (
  token: string,
  expected: { readonly issuer: string; readonly audience: string; readonly nowMs: number }
): IdentityParse => {
  let payload: Record<string, unknown>;
  try {
    payload = decodeJwt(token);
  } catch {
    return { ok: false, reason: 'invalid-token' };
  }
  const audience = payload['aud'];
  const exp = payload['exp'];
  const nbf = payload['nbf'];
  const iat = payload['iat'];
  const now = Math.floor(expected.nowMs / 1000);
  if (
    payload['iss'] !== expected.issuer ||
    !(audience === expected.audience ||
      (Array.isArray(audience) &&
        audience.every(value => typeof value === 'string') &&
        audience.includes(expected.audience))) ||
    typeof exp !== 'number' || !Number.isFinite(exp) ||
    (nbf !== undefined && (typeof nbf !== 'number' || !Number.isFinite(nbf) || nbf > now)) ||
    (iat !== undefined && (typeof iat !== 'number' || !Number.isFinite(iat)))
  ) {
    return { ok: false, reason: 'invalid-claims' };
  }
  if (exp <= now) return { ok: false, reason: 'expired' };
  return parseIdTokenIdentity(payload);
};

/**
 * Runs after the standard token claims are checked. `prismical_first_party` is the
 * sign-in preflight: third-party tokens never become desktop sessions.
 */
export const parseIdTokenIdentity = (payload: Record<string, unknown>): IdentityParse => {
  const sub = payload['sub'];
  if (typeof sub !== 'string' || sub === '') return { ok: false, reason: 'missing-sub' };
  if (payload['prismical_first_party'] !== true) return { ok: false, reason: 'not-first-party' };
  const email = payload['email'];
  if (typeof email !== 'string' || email === '') return { ok: false, reason: 'missing-email' };
  const orgs = orgUsersClaimSchema.safeParse(payload['org_users'] ?? []);
  if (!orgs.success) return { ok: false, reason: 'malformed-org-users' };
  const name = payload['name'];
  const signupAt = payload['signup_at'];
  return {
    ok: true,
    value: {
      sub,
      email,
      ...(typeof name === 'string' && name !== '' ? { name } : {}),
      ...(typeof signupAt === 'string' && Number.isFinite(Date.parse(signupAt))
        ? { signupAt }
        : {}),
      orgs: orgs.data.map(org => ({ id: org.id, orgId: org.org_id, userId: org.user_id })),
    },
  };
};

// ---------------------------------------------------------------------------
// AuthState (main-side session state; tokens NEVER live here — they stay in a
// private Ref inside live.ts so state snapshots are structurally token-free)
// ---------------------------------------------------------------------------

export interface AuthAccountView {
  readonly sub: string;
  readonly email: string;
  readonly name?: string;
  readonly signupAt?: string;
  readonly activeOrgId?: string;
  readonly orgs: ReadonlyArray<OrgMembership>;
}

export interface AuthState {
  readonly gate: SessionGateState;
  /** Keyed by sub. */
  readonly accounts: Readonly<Record<string, AuthAccountView>>;
  readonly activeSub?: string;
}

export const initialAuthState: AuthState = { gate: 'signed-out', accounts: {} };

const accountFromIdentity = (
  identity: IdTokenIdentity,
  previous: AuthAccountView | undefined
): AuthAccountView => {
  // An org pick survives re-verification only while the membership still exists.
  const activeOrgId =
    previous?.activeOrgId !== undefined &&
    identity.orgs.some(org => org.orgId === previous.activeOrgId)
      ? previous.activeOrgId
      : undefined;
  return {
    sub: identity.sub,
    email: identity.email,
    ...(identity.name === undefined ? {} : { name: identity.name }),
    ...(identity.signupAt === undefined ? {} : { signupAt: identity.signupAt }),
    ...(activeOrgId === undefined ? {} : { activeOrgId }),
    orgs: identity.orgs,
  };
};

/** Successful code exchange: upsert the account and make it active. */
export const applySignIn = (state: AuthState, identity: IdTokenIdentity): AuthState => ({
  gate: 'signed-in',
  accounts: {
    ...state.accounts,
    [identity.sub]: accountFromIdentity(identity, state.accounts[identity.sub]),
  },
  activeSub: identity.sub,
});

/**
 * Successful refresh: update the account's verified claims in place. A refresh
 * for an account that was signed out mid-flight changes nothing (a late
 * refresh must never resurrect a removed account).
 */
export const applyRefreshedIdentity = (state: AuthState, identity: IdTokenIdentity): AuthState => {
  const previous = state.accounts[identity.sub];
  if (previous === undefined) return state;
  const gate =
    state.activeSub === identity.sub && (state.gate === 'refreshing' || state.gate === 'offline')
      ? 'signed-in'
      : state.gate;
  return {
    ...state,
    gate,
    accounts: { ...state.accounts, [identity.sub]: accountFromIdentity(identity, previous) },
  };
};

/** Definitive refresh rejection or sign-out: the account leaves the session. */
export const dropAccount = (state: AuthState, sub: string): AuthState => {
  const remaining = Object.fromEntries(
    Object.entries(state.accounts).filter(([key]) => key !== sub)
  );
  if (state.activeSub === sub) {
    return { gate: 'signed-out', accounts: remaining };
  }
  return { ...state, accounts: remaining };
};

/** Transient refresh failure: only the ACTIVE account without a live token goes offline. */
export const applyTransientRefreshFailure = (
  state: AuthState,
  sub: string,
  hasValidToken: boolean
): AuthState =>
  state.activeSub === sub &&
  !hasValidToken &&
  (state.gate === 'signed-in' || state.gate === 'refreshing')
    ? { ...state, gate: 'offline' }
    : state;

/** null clears the pick (server default org resolves per request). */
export const setAccountOrg = (state: AuthState, sub: string, orgId: string | null): AuthState => {
  const account = state.accounts[sub];
  if (account === undefined) return state;
  const next: AuthAccountView = {
    sub: account.sub,
    email: account.email,
    ...(account.name === undefined ? {} : { name: account.name }),
    ...(account.signupAt === undefined ? {} : { signupAt: account.signupAt }),
    ...(orgId === null ? {} : { activeOrgId: orgId }),
    orgs: account.orgs,
  };
  return { ...state, accounts: { ...state.accounts, [sub]: next } };
};

/** Projection onto the sanitized IPC view (sessionViewSchema is .strict()). */
export const toSessionView = (state: AuthState): SessionView => ({
  state: state.gate,
  accounts: Object.values(state.accounts).map(account => ({
    sub: account.sub,
    email: account.email,
    ...(account.name === undefined ? {} : { name: account.name }),
    ...(account.signupAt === undefined ? {} : { signupAt: account.signupAt }),
    ...(account.activeOrgId === undefined ? {} : { activeOrgId: account.activeOrgId }),
  })),
  ...(state.activeSub === undefined ? {} : { activeSub: state.activeSub }),
});

// ---------------------------------------------------------------------------
// Account index codec (non-secret restart persistence; secrets go to SecureStore)
// ---------------------------------------------------------------------------

const indexOrgSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  userId: z.string().min(1),
});

const indexAccountSchema = z.object({
  sub: z.string().min(1),
  email: z.string().min(1),
  name: z.string().min(1).optional(),
  signupAt: z.string().optional(),
  activeOrgId: z.string().min(1).optional(),
  orgs: z.array(indexOrgSchema),
});

const accountIndexSchema = z.object({
  version: z.literal(1),
  activeSub: z.string().min(1).nullable(),
  accounts: z.array(indexAccountSchema),
});

export const encodeAccountIndex = (state: AuthState): string =>
  JSON.stringify({
    version: 1,
    activeSub: state.activeSub ?? null,
    accounts: Object.values(state.accounts),
  });

/**
 * Restores the account roster from the settings row. Accounts come back
 * token-less ('refreshing' when an active one exists — the eager restore
 * refresh resolves it to signed-in/offline/dropped); a corrupt index degrades
 * to signed-out, never a boot failure.
 */
export const restoreAuthState = (raw: string | null): AuthState => {
  if (raw === null) return initialAuthState;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return initialAuthState;
  }
  const parsed = accountIndexSchema.safeParse(json);
  if (!parsed.success) return initialAuthState;
  const accounts = Object.fromEntries(parsed.data.accounts.map(account => [account.sub, account]));
  const activeSub =
    parsed.data.activeSub !== null && accounts[parsed.data.activeSub] !== undefined
      ? parsed.data.activeSub
      : undefined;
  return {
    gate: activeSub === undefined ? 'signed-out' : 'refreshing',
    accounts,
    ...(activeSub === undefined ? {} : { activeSub }),
  };
};
