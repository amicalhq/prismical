/**
 * Deterministic fake OIDC/core server for the auth e2e suite.
 *
 * A plain node:http server on a 127.0.0.1 ephemeral port, one instance per
 * test (started/stopped in the spec — no globals). It speaks exactly the
 * wire contract the desktop auth domain implements:
 *
 *   POST /api/auth/oauth2/token   — JSON body, both grants.
 *     authorization_code: validates code/redirect_uri/code_verifier/client_id
 *       PRESENCE and rejects a reused code. True S256 verification of the
 *       challenge is impossible here — /authorize is never hit in E2E (the
 *       app's E2E guard skips the system browser), so the server never learns
 *       the code_challenge; it records the full body for spec assertions
 *       instead.
 *     refresh_token: behavior is per-test configurable (`refreshBehavior`):
 *       'rotate' (happy path, zero-grace rotation), 'revoked'
 *       (401 invalid_grant), 'server-error' (500), 'timeout' (never responds).
 *   GET  /api/auth/jwks           — the in-process test keypair's public JWK.
 *   POST /api/auth/oauth2/revoke  — records + 200.
 *   GET  /api/auth/oauth2/authorize — records + 302 (completeness only).
 *
 * Tokens are sentinel-valued strings (SENTINEL-ACCESS-n / SENTINEL-REFRESH-n)
 * plus a REAL ES256-signed id_token JWT with the claims core mints
 * (prismical_first_party, org_users, email/name) — the auth-sentinel spec
 * scans for these exact strings, so every minted set is kept in `minted`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolveTarget } from './launch';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
  /** Lowercased request headers (node normalizes names) — the transport lane
   *  asserts the Bearer id_token + x-active-org-id it stamped were received. */
  readonly headers: Record<string, string | string[] | undefined>;
}

export interface MintedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string;
}

/**
 * One POST /apps/v1/me/ask stream. `finished` ⇒ the SSE ran to
 * `data: [DONE]`; `aborted` ⇒ the client dropped the connection mid-stream (the
 * desktop cancel path interrupts the main producer, which aborts the fetch — the
 * fake server observes the socket close here).
 */
export interface AskStreamRecord {
  finished: boolean;
  aborted: boolean;
  readonly authorization: string | undefined;
}

/**
 * 'rotate' and 'revoked' are driven by the e2e specs. 'server-error' and
 * 'timeout' are INTENTIONALLY unexercised at the e2e level: the 15 s token
 * budget and the 5xx-transient path are pinned at the unit layer under
 * TestClock (tests/services/auth.test.ts — deep time stays out of e2e); they
 * remain here for wire-contract parity should a spec ever need them live.
 */
export type RefreshBehavior = 'rotate' | 'revoked' | 'server-error' | 'timeout';

export interface FakeOAuthOptions {
  /** Identity baked into every minted id_token. */
  readonly sub?: string;
  readonly email?: string;
  readonly name?: string;
  /**
   * The `org_users` memberships baked into every minted id_token (user_id is the
   * sub). Default: one org — the org-switch spec passes two so a re-scope is
   * meaningful (org selection validates against exactly this claim).
   */
  readonly orgUsers?: ReadonlyArray<{ readonly id: string; readonly org_id: string }>;
  /** access-token expires_in seconds (default 3600 — clear of the 10-min refresh skew). */
  readonly expiresInSeconds?: number;
  /** id_token exp horizon in seconds (default matches expiresInSeconds). */
  readonly idTokenTtlSeconds?: number;
  /** When set, serve one organization with this effective integrations flag. */
  readonly integrationsEnabled?: boolean;
  /** Role returned by the organization endpoint when it is enabled. Default: owner. */
  readonly organizationRole?: 'owner' | 'admin' | 'member';
}

export interface FakeOAuthServer {
  /** http://127.0.0.1:<port> — inject as PRISMICAL_CORE_API_URL. */
  readonly origin: string;
  readonly sub: string;
  readonly email: string;
  /** The org ids baked into the id_token's org_users claim (org-switch spec). */
  readonly orgIds: ReadonlyArray<string>;
  /** Every request in arrival order (all endpoints, including jwks). */
  readonly requests: ReadonlyArray<RecordedRequest>;
  /** Every token set ever minted, in mint order (exchange first, then rotations). */
  readonly minted: ReadonlyArray<MintedTokens>;
  /** Every /apps/v1/me/ask SSE stream opened, in arrival order. */
  readonly askConnections: ReadonlyArray<AskStreamRecord>;
  refreshBehavior: RefreshBehavior;
  readonly setIntegrationsEnabled: (enabled: boolean) => void;
  readonly count: (path: string) => number;
  readonly tokenRequests: () => RecordedRequest[];
  readonly exchangeRequests: () => RecordedRequest[];
  readonly refreshRequests: () => RecordedRequest[];
  readonly revokeRequests: () => RecordedRequest[];
  readonly close: () => Promise<void>;
}

const TOKEN_PATH = '/api/auth/oauth2/token';
const REVOKE_PATH = '/api/auth/oauth2/revoke';
const AUTHORIZE_PATH = '/api/auth/oauth2/authorize';
const JWKS_PATH = '/api/auth/jwks';
const WEB_HANDOFF_PATH = '/api/auth/handoff/web-session';
/** core's versioned app-only sync prefix (transport allowlist). */
const ME_PATH = '/apps/v1/me';
/** core's streaming Ask endpoint (POST → AI-SDK UI-message-stream SSE). */
const ASK_PATH = '/apps/v1/me/ask';

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(payload);
};

export async function startFakeOAuthServer(
  options: FakeOAuthOptions = {}
): Promise<FakeOAuthServer> {
  const sub = options.sub ?? 'user_e2e_1';
  const email = options.email ?? 'e2e-user@prismicaltest.com';
  const name = options.name ?? 'E2E User';
  const orgUsers = options.orgUsers ?? [{ id: 'org_user_e2e_1', org_id: 'org_e2e_1' }];
  const expiresIn = options.expiresInSeconds ?? 3600;
  const idTokenTtl = options.idTokenTtlSeconds ?? expiresIn;
  let integrationsEnabled = options.integrationsEnabled;
  const organizationRole = options.organizationRole ?? 'owner';

  // In-process ES256 keypair; the public half is served on /api/auth/jwks and
  // the app's createRemoteJWKSet verifies every id_token against it.
  const keys = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = { ...(await exportJWK(keys.publicKey)), kid: 'e2e-key-1', alg: 'ES256', use: 'sig' };

  const requests: RecordedRequest[] = [];
  const minted: MintedTokens[] = [];
  const askConnections: AskStreamRecord[] = [];
  const usedCodes = new Set<string>();
  /** Refresh tokens minted and not yet rotated away (zero-grace rotation). */
  const liveRefreshTokens = new Set<string>();
  const sockets = new Set<Socket>();
  let mintCounter = 0;

  let origin = ''; // assigned after listen()

  const mintTokenSet = async (clientId: string): Promise<MintedTokens> => {
    mintCounter += 1;
    const nonce = mintCounter;
    const idToken = await new SignJWT({
      email,
      name,
      prismical_first_party: true,
      org_users: orgUsers.map(org => ({ id: org.id, org_id: org.org_id, user_id: sub })),
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'e2e-key-1' })
      .setIssuer(`${origin}/api/auth`)
      .setSubject(sub)
      .setAudience(clientId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + idTokenTtl)
      .sign(keys.privateKey);
    const set: MintedTokens = {
      accessToken: `SENTINEL-ACCESS-${nonce}`,
      refreshToken: `SENTINEL-REFRESH-${nonce}`,
      idToken,
    };
    minted.push(set);
    liveRefreshTokens.add(set.refreshToken);
    return set;
  };

  const tokenResponseBody = (set: MintedTokens): Record<string, unknown> => ({
    access_token: set.accessToken,
    expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    token_type: 'Bearer',
    refresh_token: set.refreshToken,
    scope: 'openid profile email offline_access',
    id_token: set.idToken,
  });

  const handleToken = async (
    body: Record<string, unknown>,
    response: ServerResponse
  ): Promise<void> => {
    if (body['grant_type'] === 'authorization_code') {
      const code = body['code'];
      const clientId = body['client_id'];
      const missing =
        typeof code !== 'string' ||
        code === '' ||
        typeof body['redirect_uri'] !== 'string' ||
        typeof body['code_verifier'] !== 'string' ||
        body['code_verifier'] === '' ||
        typeof clientId !== 'string' ||
        clientId === '';
      if (missing) {
        sendJson(response, 400, { error: 'invalid_request' });
        return;
      }
      if (usedCodes.has(code)) {
        // Codes are single-use server-side (600 s TTL) — a replay must fail.
        sendJson(response, 400, { error: 'invalid_grant', error_description: 'code reused' });
        return;
      }
      usedCodes.add(code);
      sendJson(response, 200, tokenResponseBody(await mintTokenSet(clientId)));
      return;
    }

    if (body['grant_type'] === 'refresh_token') {
      switch (api.refreshBehavior) {
        case 'revoked':
          sendJson(response, 401, { error: 'invalid_grant' });
          return;
        case 'server-error':
          sendJson(response, 500, { error: 'internal_error' });
          return;
        case 'timeout':
          // Hold the request open — the app's 15 s token budget must trip.
          return;
        case 'rotate': {
          const presented = body['refresh_token'];
          const clientId = body['client_id'];
          if (
            typeof presented !== 'string' ||
            typeof clientId !== 'string' ||
            !liveRefreshTokens.has(presented)
          ) {
            // Unknown or already-rotated token — definitive rejection under
            // zero-grace rotation.
            sendJson(response, 401, { error: 'invalid_grant' });
            return;
          }
          liveRefreshTokens.delete(presented);
          sendJson(response, 200, tokenResponseBody(await mintTokenSet(clientId)));
          return;
        }
      }
    }

    sendJson(response, 400, { error: 'unsupported_grant_type' });
  };

  const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

  /**
   * POST /apps/v1/me/ask → an AI-SDK UI-message-stream over SSE (what core's
   * `toUIMessageStreamResponse()` emits): `start` → text deltas → `finish` →
   * `data: [DONE]`. Body markers steer the (test-only) variant:
   *  - default: fast text-delta stream.
   *  - `variant:'slow'`: a long gap after the first delta so a spec can cancel
   *    mid-stream (the connection drop is recorded as `aborted`).
   *  - `variant:'approval'`: the turn pauses on a tool needing approval (tool
   *    chunk + finish, no text); `resume:true` streams the continuation — the
   *    approval-resume round-trip (a fresh POST, like web).
   */
  const handleAsk = async (
    body: Record<string, unknown> | null,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    const record: AskStreamRecord = {
      finished: false,
      aborted: false,
      authorization:
        typeof request.headers['authorization'] === 'string'
          ? request.headers['authorization']
          : undefined,
    };
    askConnections.push(record);
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-vercel-ai-ui-message-stream': 'v1',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    response.on('close', () => {
      if (!record.finished) record.aborted = true;
    });
    const alive = (): boolean => !response.writableEnded && !response.destroyed && !record.aborted;
    const frame = (obj: unknown): void => {
      if (!alive()) return;
      try {
        response.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {
        // Socket already gone — the close handler recorded the abort.
      }
    };

    const variant = typeof body?.['variant'] === 'string' ? (body['variant'] as string) : 'stream';
    const isResume = body?.['resume'] === true;

    if (variant === 'approval' && !isResume) {
      // Turn pauses on a tool needing approval: tool chunk + finish, no text.
      frame({ type: 'start' });
      frame({ type: 'tool-input-start', toolCallId: 'tool_1', toolName: 'demo' });
      frame({ type: 'tool-input-available', toolCallId: 'tool_1', toolName: 'demo', input: {} });
      frame({ type: 'finish' });
      if (alive()) response.write('data: [DONE]\n\n');
      record.finished = true;
      response.end();
      return;
    }

    const deltas =
      variant === 'approval' ? ['Approved', ' — done'] : ['Hello', ' from', ' Prismical'];
    const gap = variant === 'slow' ? 400 : 15;
    frame({ type: 'start' });
    frame({ type: 'text-start', id: 't1' });
    for (const piece of deltas) {
      if (!alive()) return;
      frame({ type: 'text-delta', id: 't1', delta: piece });
      await delay(gap);
    }
    if (!alive()) return;
    frame({ type: 'text-end', id: 't1' });
    frame({ type: 'finish' });
    response.write('data: [DONE]\n\n');
    record.finished = true;
    response.end();
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', origin);
      const method = request.method ?? 'GET';
      const raw = await readBody(request);
      let body: Record<string, unknown> | null = null;
      try {
        body = raw === '' ? null : (JSON.parse(raw) as Record<string, unknown>);
      } catch {
        body = null;
      }
      requests.push({ method, path: url.pathname, body, headers: request.headers });

      if (method === 'POST' && url.pathname === TOKEN_PATH) {
        await handleToken(body ?? {}, response);
        return;
      }
      if (method === 'POST' && url.pathname === WEB_HANDOFF_PATH) {
        const returnPath = typeof body?.['return'] === 'string' ? body['return'] : '/';
        // The handoff URL must satisfy the app's CONFIG-derived allowlist
        // (auth/live.ts isAllowedWebHandoffUrl): the app under test resolves
        // webAppOrigin per packaging — prod default when packaged, the dev
        // portless origin when the bundle target runs unpackaged. A baked
        // prod hostname here made bundle runs silently take the unsafe-url
        // branch.
        const webOrigin =
          resolveTarget() === 'packaged'
            ? 'https://app.prismical.ai'
            : 'https://prismical-web.localhost';
        const handoffUrl = new URL('/auth/handoff', webOrigin);
        handoffUrl.searchParams.set('token', 'desktop-e2e-handoff-token');
        if (returnPath !== '/') handoffUrl.searchParams.set('return', returnPath);
        sendJson(response, 200, { url: handoffUrl.toString() });
        return;
      }
      // POST /apps/v1/me/ask → SSE UI-message-stream. Matched BEFORE the
      // generic /me envelope below (it lives under the same prefix).
      if (method === 'POST' && url.pathname === ASK_PATH) {
        await handleAsk(body, request, response);
        return;
      }
      if (
        method === 'GET' &&
        url.pathname === `${ME_PATH}/organizations` &&
        integrationsEnabled !== undefined
      ) {
        const membership = orgUsers[0]!;
        sendJson(response, 200, {
          results: [
            {
              orgUserId: membership.id,
              orgId: membership.org_id,
              name: 'E2E Organization',
              slug: 'e2e-organization',
              role: organizationRole,
              allowPublicSharing: false,
              features: { integrations: integrationsEnabled, customMcpServers: true },
              memberCount: 1,
            },
          ],
        });
        return;
      }
      // Stand in for core's app-only sync lane (/apps/v1/me[/…]) so the
      // desktop transport lane can be exercised end-to-end after a fake sign-in.
      // A generic list envelope — no sentinel material ever enters this body.
      if (url.pathname === ME_PATH || url.pathname.startsWith(`${ME_PATH}/`)) {
        sendJson(response, 200, { results: [] });
        return;
      }
      if (method === 'POST' && url.pathname === REVOKE_PATH) {
        sendJson(response, 200, {});
        return;
      }
      if (method === 'GET' && url.pathname === JWKS_PATH) {
        sendJson(response, 200, { keys: [publicJwk] });
        return;
      }
      if (method === 'GET' && url.pathname === AUTHORIZE_PATH) {
        // Never reached in E2E (the app skips the browser); kept for
        // completeness so a misfire is visible as a recorded 302.
        response.writeHead(302, { location: 'prismical-dev://oauth/callback?error=e2e_authorize_hit' });
        response.end();
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    })().catch(() => {
      response.destroy();
    });
  });

  // Track sockets so close() can sever held connections ('timeout' behavior
  // and keep-alive agents would otherwise wedge server.close()).
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;

  const tokenRequests = () => requests.filter(r => r.method === 'POST' && r.path === TOKEN_PATH);

  const api: FakeOAuthServer = {
    origin,
    sub,
    email,
    orgIds: orgUsers.map(org => org.org_id),
    requests,
    minted,
    askConnections,
    refreshBehavior: 'rotate',
    setIntegrationsEnabled: enabled => {
      integrationsEnabled = enabled;
    },
    count: path => requests.filter(r => r.path === path).length,
    tokenRequests,
    exchangeRequests: () =>
      tokenRequests().filter(r => r.body?.['grant_type'] === 'authorization_code'),
    refreshRequests: () => tokenRequests().filter(r => r.body?.['grant_type'] === 'refresh_token'),
    revokeRequests: () => requests.filter(r => r.method === 'POST' && r.path === REVOKE_PATH),
    close: () =>
      new Promise<void>(resolve => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  return api;
}
