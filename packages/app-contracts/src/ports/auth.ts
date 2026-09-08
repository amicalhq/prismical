// AuthPort — authentication seam shared by the renderers.
//
// Shared code sees a SANITIZED session view — never token material. The view
// types mirror packages/desktop-contracts/src/main-window.ts (SessionView /
// SessionAccount / gate states) field-for-field so the desktop adapter
// passes `window.desktop.auth` payloads through untouched. The web adapter
// bridges the existing AuthProvider (lib/auth/auth-context.tsx) into this
// shape.

/** Sign-in gate state (pending/offline are explicit, never a fake shell). */
export type SessionGateState =
  | "signed-out"
  | "signing-in"
  | "signed-in"
  | "refreshing"
  | "offline";

/** One signed-in account as shared code sees it. Structurally token-free. */
export interface SessionAccount {
  readonly sub: string;
  /** Optional platform session identity; web uses it to isolate same-sub logins. */
  readonly sessionKey?: string;
  readonly email: string;
  readonly name?: string;
  /** Account creation time for the optional first-use welcome; absent on older clients. */
  readonly signupAt?: string;
  readonly activeOrgId?: string;
}

/** The sanitized multi-account session view. */
export interface SessionView {
  readonly state: SessionGateState;
  readonly accounts: readonly SessionAccount[];
  readonly activeSub?: string;
  /** Active login identity when it is more specific than the product user `sub`. */
  readonly activeSessionKey?: string;
}

export interface AuthPort {
  /** Current sanitized view. Identity-stable until the session changes. */
  getSession(): SessionView;
  /** Session-changed fan-out; fires with each new view. Returns unsubscribe. */
  onSessionChanged(listener: (view: SessionView) => void): () => void;
  /**
   * Start sign-in (web: PKCE redirect via the login app; desktop: main-owned
   * PKCE through the system browser). Resolves when the flow STARTS;
   * completion arrives as an onSessionChanged push.
   */
  signIn(): Promise<void>;
  /**
   * Start ADDING a further account, as distinct from `signIn()`. The two differ
   * on web, where core holds a session cookie: a plain `signIn()` reuses it and
   * silently re-adds the SAME account, so the web adapter clears the cookie and
   * forces the login form (`prompt=login`). Desktop's sign-in is already
   * account-additive, so its adapter maps this straight to `signIn()`.
   * Resolves when the flow STARTS; completion arrives as an onSessionChanged push.
   */
  addAccount(): Promise<void>;
  /** Sign out the ACTIVE account (web semantics; desktop maps to auth:signOut). */
  signOut(): Promise<void>;
  /** Switch to another already-signed-in account/session key. */
  switchAccount(sessionKey: string): void;
  /** Switch the active organization; re-scopes every subsequent request. */
  switchOrg(orgId: string): void;
  /**
   * The `setAuthToken`-shaped seam, read side: the current bearer for the note
   * collaboration WSS connect callback — the one designed full-token crossing.
   * Web reads the auth module seam; desktop fetches from
   * main per (re)connect. Never for stamping REST headers — on desktop those
   * are stamped in main, behind TransportPort.
   */
  getToken(): Promise<string | null>;
  /**
   * Return a bearer only when the platform's authoritative auth store still
   * has this exact login + organization active. Unlike getSession(), this
   * check and token read must be atomic so a reactive publication lag cannot
   * restamp delayed work with a replacement login.
   */
  getTokenForSession(
    expectedSessionKey: string,
    expectedOrgId?: string | null,
  ): Promise<string | null>;
}
