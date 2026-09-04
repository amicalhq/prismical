/**
 * Pure deep-link parsing for the OAuth-attempt contract and deep-link boundary.
 * Table-driven tests are in tests/policy/deep-link.test.ts.
 *
 * Grammar:
 *   prismical://oauth/callback?code=…&state=…                → OAuthCallback
 *   prismical://oauth/callback?error=…[&error_description=…][&state=…]
 *                                                             → OAuthError
 *   prismical://app/<path>[?query]                            → Navigate {path}
 *   anything else                                             → Unknown {reason}
 * error + code together is contradictory — rejected, never exchanged.
 * prismical-dev:// is accepted only in unpackaged builds.
 */
export type ParsedDeepLink =
  | { readonly _tag: 'OAuthCallback'; readonly code: string; readonly state: string }
  | {
      readonly _tag: 'OAuthError';
      readonly error: string;
      readonly errorDescription?: string;
      readonly state?: string;
    }
  | { readonly _tag: 'Navigate'; readonly path: string }
  | { readonly _tag: 'Unknown'; readonly url: string; readonly reason: string };

export const PROD_SCHEME = 'prismical:';
export const DEV_SCHEME = 'prismical-dev:';

export interface DeepLinkOptions {
  readonly allowDevScheme: boolean;
}

export function parseDeepLink(rawUrl: string, options: DeepLinkOptions): ParsedDeepLink {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { _tag: 'Unknown', url: rawUrl, reason: 'unparseable' };
  }

  const schemeOk =
    url.protocol === PROD_SCHEME || (options.allowDevScheme && url.protocol === DEV_SCHEME);
  if (!schemeOk) {
    return { _tag: 'Unknown', url: rawUrl, reason: 'scheme' };
  }

  if (url.host === 'oauth') {
    if (url.pathname !== '/callback') {
      return { _tag: 'Unknown', url: rawUrl, reason: 'oauth-path' };
    }
    const codes = url.searchParams.getAll('code');
    const states = url.searchParams.getAll('state');
    const errors = url.searchParams.getAll('error');

    // error + code together is contradictory — reject, never exchange.
    if (errors.length > 0 && codes.length > 0) {
      return { _tag: 'Unknown', url: rawUrl, reason: 'error-and-code' };
    }

    if (errors.length > 0) {
      // Provider error redirect (RFC 6749 §4.1.2.1): error, optional
      // error_description and state. Duplicates stay an injection smell.
      const descriptions = url.searchParams.getAll('error_description');
      if (errors.length !== 1 || states.length > 1 || descriptions.length > 1) {
        return { _tag: 'Unknown', url: rawUrl, reason: 'param-count' };
      }
      const error = errors[0];
      const state = states[0];
      if (error === undefined || error === '' || state === '') {
        return { _tag: 'Unknown', url: rawUrl, reason: 'param-empty' };
      }
      const errorDescription = descriptions[0];
      return {
        _tag: 'OAuthError',
        error,
        ...(errorDescription === undefined ? {} : { errorDescription }),
        ...(state === undefined ? {} : { state }),
      };
    }

    // Duplicate params are an injection smell — never exchange them.
    if (codes.length !== 1 || states.length !== 1) {
      return { _tag: 'Unknown', url: rawUrl, reason: 'param-count' };
    }
    const code = codes[0];
    const state = states[0];
    if (code === undefined || state === undefined || code === '' || state === '') {
      return { _tag: 'Unknown', url: rawUrl, reason: 'param-empty' };
    }
    return { _tag: 'OAuthCallback', code, state };
  }

  if (url.host === 'app') {
    const path = url.pathname === '' ? '/' : url.pathname;
    return { _tag: 'Navigate', path: `${path}${url.search}` };
  }

  return { _tag: 'Unknown', url: rawUrl, reason: 'host' };
}

/**
 * Log-safe projection of a rejected deep link:
 * scheme + host + path + query param NAMES only — never values. Several
 * Unknown arms carry oauth-callback-shaped URLs holding real authorization
 * codes (error-and-code, duplicated code/state param-count, param-empty), and
 * the field-name redactor cannot scan string values, so the raw URL must never
 * reach a log call. Unparseable input yields only its length.
 */
export function describeRejectedDeepLink(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `<unparseable url, length ${rawUrl.length}>`;
  }
  const names = [...new Set(url.searchParams.keys())];
  const query = names.length === 0 ? '' : `?${names.join(',')}`;
  return `${url.protocol}//${url.host}${url.pathname}${query}`;
}

/** Scans a second-instance argv for deep-link URLs (Windows/Linux delivery path). */
export function deepLinksFromArgv(
  argv: ReadonlyArray<string>,
  options: DeepLinkOptions
): string[] {
  const prefixes = [`${PROD_SCHEME}//`];
  if (options.allowDevScheme) prefixes.push(`${DEV_SCHEME}//`);
  return argv.filter(arg => prefixes.some(prefix => arg.startsWith(prefix)));
}
