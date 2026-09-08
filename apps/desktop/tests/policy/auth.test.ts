/**
 * Pure auth policy tests: PKCE vectors, authorize-URL construction,
 * attempt lifecycle + constant-time state matching, token-response parsing,
 * verified-identity claim parsing, AuthState transitions and the sanitized
 * session-view projection.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseSessionView } from '@prismical/desktop-contracts';
import {
  ATTEMPT_TTL_MS,
  applyRefreshedIdentity,
  applySignIn,
  applyTransientRefreshFailure,
  buildAuthorizeUrl,
  constantTimeEqual,
  decodeJwtExpiryMs,
  dropAccount,
  encodeAccountIndex,
  idleAttempt,
  initialAuthState,
  launchAttempt,
  makePkceMaterial,
  matchAttempt,
  parseIdToken,
  parseIdTokenIdentity,
  parseTokenResponse,
  restoreAuthState,
  setAccountOrg,
  toSessionView,
  type AuthState,
  type IdTokenIdentity,
  type RandomSource,
} from '../../src/main/domains/auth/policy';

/** Deterministic bytes 1..n so vectors are reproducible by hand. */
const fixedRandom: RandomSource = length => Uint8Array.from({ length }, (_, i) => i + 1);

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

const unsignedJwt = (payload: Record<string, unknown>): string =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
    JSON.stringify(payload)
  ).toString('base64url')}.sig`;

const identity = (overrides: Partial<IdTokenIdentity> = {}): IdTokenIdentity => ({
  sub: 'user_1',
  email: 'u1@example.com',
  name: 'User One',
  orgs: [{ id: 'ou_1', orgId: 'org_1', userId: 'user_1' }],
  ...overrides,
});

describe('auth policy — PKCE (RFC 7636)', () => {
  it('derives verifier/challenge/state from the injected randomness', () => {
    const pkce = makePkceMaterial(fixedRandom);
    const expectedVerifier = b64url(fixedRandom(32));
    expect(pkce.verifier).toBe(expectedVerifier);
    expect(pkce.challenge).toBe(
      createHash('sha256').update(expectedVerifier).digest().toString('base64url')
    );
    expect(pkce.state).toBe(b64url(fixedRandom(16)));
  });

  it('matches the RFC 7636 appendix B S256 vector', () => {
    const rfcVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const rfcBytes = Uint8Array.from(Buffer.from(rfcVerifier, 'base64url'));
    const pkce = makePkceMaterial(length =>
      length === 32 ? rfcBytes : fixedRandom(length)
    );
    expect(pkce.verifier).toBe(rfcVerifier);
    expect(pkce.challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('auth policy — authorize URL', () => {
  const base = {
    authorizeUrl: 'https://core.test/api/auth/oauth2/authorize',
    clientId: 'test-desktop-client',
    redirectUri: 'prismical-dev://oauth/callback',
    challenge: 'CH',
    state: 'ST',
  };

  it('builds the exact parameter set (web-client parity)', () => {
    const url = new URL(buildAuthorizeUrl({ ...base, promptLogin: false }));
    expect(url.origin + url.pathname).toBe('https://core.test/api/auth/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'test-desktop-client',
      redirect_uri: 'prismical-dev://oauth/callback',
      response_type: 'code',
      scope: 'openid profile email offline_access',
      code_challenge: 'CH',
      code_challenge_method: 'S256',
      state: 'ST',
    });
  });

  it('adds prompt=login only when requested (add-account flow)', () => {
    const url = new URL(buildAuthorizeUrl({ ...base, promptLogin: true }));
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(
      new URL(buildAuthorizeUrl({ ...base, promptLogin: false })).searchParams.has('prompt')
    ).toBe(false);
  });
});

describe('auth policy — attempt lifecycle', () => {
  const pkce = makePkceMaterial(fixedRandom);
  const t0 = 1_000_000;

  it('idle → launched: carries verifier/state and a TTL-bound expiry', () => {
    const launched = launchAttempt(pkce, t0);
    expect(launched).toEqual({
      _tag: 'Launched',
      verifier: pkce.verifier,
      state: pkce.state,
      expiresAt: t0 + ATTEMPT_TTL_MS,
    });
  });

  it('matchAttempt: matching state within TTL consumes with the verifier', () => {
    const launched = launchAttempt(pkce, t0);
    expect(matchAttempt(launched, pkce.state, t0 + 1)).toEqual({
      _tag: 'Consume',
      verifier: pkce.verifier,
    });
  });

  it('matchAttempt: wrong state, idle slot, and expired attempt never consume', () => {
    const launched = launchAttempt(pkce, t0);
    expect(matchAttempt(launched, 'attacker-state', t0 + 1)).toEqual({ _tag: 'Reject' });
    expect(matchAttempt(idleAttempt, pkce.state, t0 + 1)).toEqual({ _tag: 'Reject' });
    expect(matchAttempt(launched, pkce.state, t0 + ATTEMPT_TTL_MS)).toEqual({ _tag: 'Expired' });
  });

  it('constantTimeEqual compares correctly across lengths', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('auth policy — token response parsing', () => {
  const now = 5_000_000;
  const valid = {
    access_token: 'AT',
    expires_in: 36000,
    token_type: 'Bearer',
    refresh_token: 'RT',
    scope: 'openid',
    id_token: 'ID.ID.ID',
  };

  it('parses a numeric expires_in into an absolute expiry', () => {
    const parsed = parseTokenResponse(valid, now);
    expect(parsed).toEqual({
      ok: true,
      value: { accessToken: 'AT', idToken: 'ID.ID.ID', refreshToken: 'RT', expiresAt: now + 36_000_000 },
    });
  });

  it('accepts a string expires_in (server variance)', () => {
    const parsed = parseTokenResponse({ ...valid, expires_in: '600' }, now);
    expect(parsed.ok && parsed.value.expiresAt).toBe(now + 600_000);
  });

  it('missing refresh_token parses to null (caller keeps the old token)', () => {
    const parsed = parseTokenResponse({ ...valid, refresh_token: undefined }, now);
    expect(parsed.ok && parsed.value.refreshToken).toBe(null);
  });

  it("falls back to the id_token's own exp when expires_in is absent", () => {
    const idToken = unsignedJwt({ exp: 7_777 });
    const parsed = parseTokenResponse({ ...valid, expires_in: undefined, id_token: idToken }, now);
    expect(parsed.ok && parsed.value.expiresAt).toBe(7_777_000);
  });

  it('rejects responses without any expiry source or without tokens', () => {
    expect(parseTokenResponse({ ...valid, expires_in: undefined, id_token: 'no-exp-here' }, now).ok).toBe(false);
    expect(parseTokenResponse({ ...valid, access_token: '' }, now).ok).toBe(false);
    expect(parseTokenResponse({ ...valid, id_token: undefined }, now).ok).toBe(false);
    expect(parseTokenResponse('garbage', now).ok).toBe(false);
  });

  it('decodeJwtExpiryMs handles valid payloads and garbage', () => {
    expect(decodeJwtExpiryMs(unsignedJwt({ exp: 12 }))).toBe(12_000);
    expect(decodeJwtExpiryMs(unsignedJwt({}))).toBe(null);
    expect(decodeJwtExpiryMs('not-a-jwt')).toBe(null);
    expect(decodeJwtExpiryMs('a.!!!.c')).toBe(null);
  });
});

describe('auth policy — ID token claims', () => {
  const claims = {
    sub: 'user_1',
    email: 'u1@example.com',
    name: 'User One',
    prismical_first_party: true,
    org_users: [{ id: 'ou_1', org_id: 'org_1', user_id: 'user_1' }],
  };

  const expected = {
    issuer: 'https://core.test/api/auth',
    audience: 'desktop-client',
    nowMs: 1_000_000,
  };
  const tokenClaims = {
    ...claims,
    iss: expected.issuer,
    aud: expected.audience,
    exp: 2_000,
    iat: 900,
    nbf: 1_000,
  };

  it('accepts valid claims without verifying a token signature', () => {
    expect(parseIdToken(unsignedJwt(tokenClaims), expected)).toEqual({
      ok: true,
      value: identity(),
    });
    expect(parseIdToken(unsignedJwt({ ...tokenClaims, aud: [expected.audience] }), expected).ok)
      .toBe(true);
  });

  it.each([
    ['wrong issuer', { iss: 'https://other.test/api/auth' }],
    ['missing issuer', { iss: undefined }],
    ['wrong audience', { aud: 'web-client' }],
    ['missing audience', { aud: undefined }],
    ['audience array without desktop', { aud: ['web-client'] }],
    ['malformed audience array', { aud: [expected.audience, 1] }],
    ['missing expiry', { exp: undefined }],
    ['string expiry', { exp: '2000' }],
    ['future not-before', { nbf: 1_001 }],
    ['string not-before', { nbf: '1000' }],
    ['string issued-at', { iat: '900' }],
  ])('rejects %s', (_name, overrides) => {
    expect(parseIdToken(unsignedJwt({ ...tokenClaims, ...overrides }), expected)).toEqual({
      ok: false,
      reason: 'invalid-claims',
    });
  });

  it('rejects an expired token, including the exact expiry boundary', () => {
    for (const exp of [999, 1_000]) {
      expect(parseIdToken(unsignedJwt({ ...tokenClaims, exp }), expected)).toEqual({
        ok: false,
        reason: 'expired',
      });
    }
  });

  it('rejects malformed tokens', () => {
    for (const token of ['not-a-jwt', 'a.!!!.c', 'a.bnVsbA.c']) {
      expect(parseIdToken(token, expected)).toEqual({ ok: false, reason: 'invalid-token' });
    }
  });

  it('parses the full claim set including org memberships', () => {
    expect(parseIdTokenIdentity(claims)).toEqual({ ok: true, value: identity() });
  });

  it('carries a verified signup date without guessing one for older tokens', () => {
    const signupAt = '2026-09-08T00:00:00.000Z';
    expect(parseIdTokenIdentity({ ...claims, signup_at: signupAt })).toEqual({
      ok: true,
      value: identity({ signupAt }),
    });
    for (const signup_at of [undefined, null, 123, '', 'invalid']) {
      expect(parseIdTokenIdentity({ ...claims, signup_at })).toEqual({
        ok: true,
        value: identity(),
      });
    }
  });

  it('rejects missing sub / non-first-party / missing email / malformed org_users', () => {
    expect(parseIdTokenIdentity({ ...claims, sub: undefined })).toEqual({
      ok: false,
      reason: 'missing-sub',
    });
    expect(parseIdTokenIdentity({ ...claims, prismical_first_party: undefined })).toEqual({
      ok: false,
      reason: 'not-first-party',
    });
    expect(parseIdTokenIdentity({ ...claims, prismical_first_party: 'true' })).toEqual({
      ok: false,
      reason: 'not-first-party',
    });
    expect(parseIdTokenIdentity({ ...claims, email: undefined })).toEqual({
      ok: false,
      reason: 'missing-email',
    });
    expect(parseIdTokenIdentity({ ...claims, org_users: [{ id: 'x' }] })).toEqual({
      ok: false,
      reason: 'malformed-org-users',
    });
  });

  it('treats an absent org_users claim as an empty membership list', () => {
    const parsed = parseIdTokenIdentity({ ...claims, org_users: undefined });
    expect(parsed.ok && parsed.value.orgs).toEqual([]);
  });
});

describe('auth policy — AuthState transitions', () => {
  it('applySignIn activates the account and lands on signed-in', () => {
    const state = applySignIn(initialAuthState, identity());
    expect(state.gate).toBe('signed-in');
    expect(state.activeSub).toBe('user_1');
    expect(state.accounts['user_1']?.email).toBe('u1@example.com');
  });

  it('applyRefreshedIdentity updates claims, resolves refreshing/offline → signed-in', () => {
    const signedIn = applySignIn(initialAuthState, identity());
    const refreshing: AuthState = { ...signedIn, gate: 'refreshing' };
    const refreshed = applyRefreshedIdentity(refreshing, identity({ name: 'Renamed' }));
    expect(refreshed.gate).toBe('signed-in');
    expect(refreshed.accounts['user_1']?.name).toBe('Renamed');
    const offline: AuthState = { ...signedIn, gate: 'offline' };
    expect(applyRefreshedIdentity(offline, identity()).gate).toBe('signed-in');
  });

  it('applyRefreshedIdentity never resurrects a removed account', () => {
    const state = applyRefreshedIdentity(initialAuthState, identity());
    expect(state).toEqual(initialAuthState);
  });

  it('an org pick survives refresh only while the membership still exists', () => {
    const withOrg = setAccountOrg(applySignIn(initialAuthState, identity()), 'user_1', 'org_1');
    expect(withOrg.accounts['user_1']?.activeOrgId).toBe('org_1');
    const kept = applyRefreshedIdentity(withOrg, identity());
    expect(kept.accounts['user_1']?.activeOrgId).toBe('org_1');
    const revoked = applyRefreshedIdentity(withOrg, identity({ orgs: [] }));
    expect(revoked.accounts['user_1']?.activeOrgId).toBeUndefined();
  });

  it('dropAccount: active account leaving returns the gate to signed-out', () => {
    const two = applySignIn(applySignIn(initialAuthState, identity()), identity({ sub: 'user_2' }));
    const droppedActive = dropAccount(two, 'user_2');
    expect(droppedActive.gate).toBe('signed-out');
    expect(droppedActive.activeSub).toBeUndefined();
    expect(Object.keys(droppedActive.accounts)).toEqual(['user_1']);
    const droppedBackground = dropAccount(two, 'user_1');
    expect(droppedBackground.gate).toBe('signed-in');
    expect(droppedBackground.activeSub).toBe('user_2');
  });

  it('applyTransientRefreshFailure: only the active token-less account goes offline', () => {
    const signedIn = applySignIn(initialAuthState, identity());
    expect(applyTransientRefreshFailure(signedIn, 'user_1', false).gate).toBe('offline');
    expect(applyTransientRefreshFailure(signedIn, 'user_1', true).gate).toBe('signed-in');
    expect(applyTransientRefreshFailure(signedIn, 'user_9', false).gate).toBe('signed-in');
  });

  it('setAccountOrg sets and clears the pick', () => {
    const signedIn = applySignIn(initialAuthState, identity());
    const withOrg = setAccountOrg(signedIn, 'user_1', 'org_1');
    expect(withOrg.accounts['user_1']?.activeOrgId).toBe('org_1');
    const cleared = setAccountOrg(withOrg, 'user_1', null);
    expect(cleared.accounts['user_1']?.activeOrgId).toBeUndefined();
  });
});

describe('auth policy — session view projection', () => {
  it('projects onto the strict sessionViewSchema with zero token-shaped fields', () => {
    const state = setAccountOrg(applySignIn(initialAuthState, identity()), 'user_1', 'org_1');
    const view = toSessionView(state);
    const parsed = parseSessionView(view);
    expect(parsed.success).toBe(true);
    expect(view).toEqual({
      state: 'signed-in',
      accounts: [{ sub: 'user_1', email: 'u1@example.com', name: 'User One', activeOrgId: 'org_1' }],
      activeSub: 'user_1',
    });
    expect(JSON.stringify(view).toLowerCase()).not.toContain('token');
  });

  it('projects the signed-out initial state', () => {
    expect(toSessionView(initialAuthState)).toEqual({ state: 'signed-out', accounts: [] });
    expect(parseSessionView(toSessionView(initialAuthState)).success).toBe(true);
  });
});

describe('auth policy — account index codec (restart persistence)', () => {
  it('preserves signup metadata through org selection, restart, refresh and strict IPC', () => {
    const signupAt = '2026-09-08T00:00:00.000Z';
    const account = identity({ signupAt });
    const signedIn = setAccountOrg(applySignIn(initialAuthState, account), 'user_1', 'org_1');
    const restored = restoreAuthState(encodeAccountIndex(signedIn));
    expect(restored.accounts['user_1']?.signupAt).toBe(signupAt);
    const refreshed = applyRefreshedIdentity(restored, account);
    const view = toSessionView(refreshed);
    expect(parseSessionView(view).success).toBe(true);
    expect(view.accounts[0]?.signupAt).toBe(signupAt);
    expect(view.accounts[0]?.activeOrgId).toBe('org_1');
  });

  it('round-trips accounts + activeSub + org pick; restore lands on refreshing', () => {
    const state = setAccountOrg(applySignIn(initialAuthState, identity()), 'user_1', 'org_1');
    const restored = restoreAuthState(encodeAccountIndex(state));
    expect(restored.gate).toBe('refreshing');
    expect(restored.activeSub).toBe('user_1');
    expect(restored.accounts['user_1']).toEqual(state.accounts['user_1']);
  });

  it('restores an account roster without an active pick as signed-out', () => {
    const state: AuthState = {
      ...applySignIn(initialAuthState, identity()),
      gate: 'signed-out',
      activeSub: undefined,
    };
    const restored = restoreAuthState(encodeAccountIndex(state));
    expect(restored.gate).toBe('signed-out');
    expect(restored.activeSub).toBeUndefined();
    expect(Object.keys(restored.accounts)).toEqual(['user_1']);
  });

  it('degrades corrupt payloads to the initial state (boot stays clean)', () => {
    expect(restoreAuthState(null)).toEqual(initialAuthState);
    expect(restoreAuthState('not json')).toEqual(initialAuthState);
    expect(restoreAuthState('{"version":9}')).toEqual(initialAuthState);
    expect(restoreAuthState(JSON.stringify({ version: 1, activeSub: 'ghost', accounts: [] }))).toEqual(
      initialAuthState
    );
  });
});
