import { describe, expect, it } from 'vitest';
import {
  deepLinksFromArgv,
  describeRejectedDeepLink,
  parseDeepLink,
  type ParsedDeepLink,
} from '../../src/main/domains/deep-link/policy';

const dev = { allowDevScheme: true };
const prod = { allowDevScheme: false };

describe('parseDeepLink', () => {
  const table: Array<[string, string, { allowDevScheme: boolean }, ParsedDeepLink]> = [
    [
      'oauth callback',
      'prismical://oauth/callback?code=abc&state=xyz',
      prod,
      { _tag: 'OAuthCallback', code: 'abc', state: 'xyz' },
    ],
    [
      'oauth callback (dev scheme, dev build)',
      'prismical-dev://oauth/callback?code=abc&state=xyz',
      dev,
      { _tag: 'OAuthCallback', code: 'abc', state: 'xyz' },
    ],
    [
      'dev scheme rejected in packaged builds',
      'prismical-dev://oauth/callback?code=abc&state=xyz',
      prod,
      { _tag: 'Unknown', url: 'prismical-dev://oauth/callback?code=abc&state=xyz', reason: 'scheme' },
    ],
    [
      'wrong host',
      'prismical://evil/callback?code=abc&state=xyz',
      prod,
      { _tag: 'Unknown', url: 'prismical://evil/callback?code=abc&state=xyz', reason: 'host' },
    ],
    [
      'wrong oauth path',
      'prismical://oauth/steal?code=abc&state=xyz',
      prod,
      { _tag: 'Unknown', url: 'prismical://oauth/steal?code=abc&state=xyz', reason: 'oauth-path' },
    ],
    [
      'duplicate code param never exchanges',
      'prismical://oauth/callback?code=a&code=b&state=xyz',
      prod,
      {
        _tag: 'Unknown',
        url: 'prismical://oauth/callback?code=a&code=b&state=xyz',
        reason: 'param-count',
      },
    ],
    [
      'duplicate state param never exchanges',
      'prismical://oauth/callback?code=a&state=x&state=y',
      prod,
      {
        _tag: 'Unknown',
        url: 'prismical://oauth/callback?code=a&state=x&state=y',
        reason: 'param-count',
      },
    ],
    [
      'missing state',
      'prismical://oauth/callback?code=a',
      prod,
      { _tag: 'Unknown', url: 'prismical://oauth/callback?code=a', reason: 'param-count' },
    ],
    [
      'empty code',
      'prismical://oauth/callback?code=&state=x',
      prod,
      { _tag: 'Unknown', url: 'prismical://oauth/callback?code=&state=x', reason: 'param-empty' },
    ],
    [
      'provider error redirect (user denied consent)',
      'prismical://oauth/callback?error=access_denied',
      prod,
      { _tag: 'OAuthError', error: 'access_denied' },
    ],
    [
      'provider error with state',
      'prismical://oauth/callback?error=access_denied&state=xyz',
      prod,
      { _tag: 'OAuthError', error: 'access_denied', state: 'xyz' },
    ],
    [
      'provider error with description',
      'prismical://oauth/callback?error=invalid_request&error_description=missing%20param&state=xyz',
      prod,
      {
        _tag: 'OAuthError',
        error: 'invalid_request',
        errorDescription: 'missing param',
        state: 'xyz',
      },
    ],
    [
      'duplicate error param never surfaces',
      'prismical://oauth/callback?error=a&error=b&state=xyz',
      prod,
      {
        _tag: 'Unknown',
        url: 'prismical://oauth/callback?error=a&error=b&state=xyz',
        reason: 'param-count',
      },
    ],
    [
      'error AND code together never exchanges',
      'prismical://oauth/callback?code=abc&state=xyz&error=access_denied',
      prod,
      {
        _tag: 'Unknown',
        url: 'prismical://oauth/callback?code=abc&state=xyz&error=access_denied',
        reason: 'error-and-code',
      },
    ],
    [
      'empty error value',
      'prismical://oauth/callback?error=&state=xyz',
      prod,
      { _tag: 'Unknown', url: 'prismical://oauth/callback?error=&state=xyz', reason: 'param-empty' },
    ],
    [
      'error with empty state',
      'prismical://oauth/callback?error=access_denied&state=',
      prod,
      {
        _tag: 'Unknown',
        url: 'prismical://oauth/callback?error=access_denied&state=',
        reason: 'param-empty',
      },
    ],
    [
      'navigate',
      'prismical://app/notes/n_123?filter=starred',
      prod,
      { _tag: 'Navigate', path: '/notes/n_123?filter=starred' },
    ],
    ['navigate root', 'prismical://app/', prod, { _tag: 'Navigate', path: '/' }],
    [
      'foreign scheme',
      'https://prismical.ai/oauth/callback?code=a&state=b',
      dev,
      {
        _tag: 'Unknown',
        url: 'https://prismical.ai/oauth/callback?code=a&state=b',
        reason: 'scheme',
      },
    ],
    ['unparseable', 'not a url', dev, { _tag: 'Unknown', url: 'not a url', reason: 'unparseable' }],
  ];

  it.each(table)('%s', (_name, url, options, expected) => {
    expect(parseDeepLink(url, options)).toEqual(expected);
  });
});

describe('deepLinksFromArgv', () => {
  it('extracts prismical:// urls from a second-instance argv', () => {
    const argv = ['/usr/bin/electron', '--flag', 'prismical://oauth/callback?code=a&state=b'];
    expect(deepLinksFromArgv(argv, prod)).toEqual(['prismical://oauth/callback?code=a&state=b']);
  });

  it('honors the dev-scheme gate', () => {
    const argv = ['prismical-dev://oauth/callback?code=a&state=b'];
    expect(deepLinksFromArgv(argv, prod)).toEqual([]);
    expect(deepLinksFromArgv(argv, dev)).toEqual(argv);
  });
});

// Log custody: the Unknown-arm log line must carry parameter names
// only — the raw URL can hold real authorization codes and state values.
describe('describeRejectedDeepLink', () => {
  it('keeps scheme + host + path + param names, drops every value', () => {
    const described = describeRejectedDeepLink(
      'prismical://oauth/callback?code=SECRET-CODE-1&code=SECRET-CODE-2&state=SECRET-STATE'
    );
    expect(described).toBe('prismical://oauth/callback?code,state');
    expect(described).not.toContain('SECRET');
  });

  it('error-and-code rejections lose the code value too', () => {
    const described = describeRejectedDeepLink(
      'prismical://oauth/callback?error=access_denied&code=SECRET-CODE&state=SECRET-STATE'
    );
    expect(described).toBe('prismical://oauth/callback?error,code,state');
    expect(described).not.toContain('SECRET');
    expect(described).not.toContain('access_denied');
  });

  it('unparseable input yields only its length', () => {
    expect(describeRejectedDeepLink('code=SECRET not a url')).toBe(
      '<unparseable url, length 21>'
    );
  });

  it('a bare path keeps no stray query separator', () => {
    expect(describeRejectedDeepLink('prismical://garbage/x')).toBe('prismical://garbage/x');
  });
});
