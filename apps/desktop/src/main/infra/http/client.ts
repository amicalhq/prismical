import { version } from '../../../../package.json';
import { getApplicationLocale } from '../../domains/i18n/application-locale';

export interface ClientInfo {
  readonly appVersion: string;
  readonly platform: string;
  readonly locale: string;
}

/** Public application metadata only; never attach account or device identifiers. */
export function getClientHeaders(info: Partial<ClientInfo> = {}): Record<string, string> {
  const client: ClientInfo = {
    appVersion: info.appVersion ?? version,
    platform: info.platform ?? process.platform,
    locale: info.locale ?? getApplicationLocale(),
  };
  const platform =
    { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[client.platform] ?? client.platform;
  return {
    'User-Agent': `prismical-desktop/${client.appVersion} (${platform})`,
    'prismical-client': 'desktop',
    'prismical-version': client.appVersion,
    'prismical-platform': client.platform,
    'Accept-Language': client.locale,
  };
}

/** Normalize casing without mutating caller headers or losing auth or ranges. */
export function withClientHeaders(
  headers?: HeadersInit,
  info?: Partial<ClientInfo>
): Record<string, string> {
  const merged = new Headers(headers);
  for (const [name, value] of Object.entries(getClientHeaders(info))) {
    merged.set(name, value);
  }
  return Object.fromEntries(merged);
}

/** Main-process HTTP boundary, including requests issued by SDKs. */
export const desktopFetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, {
    ...init,
    headers: withClientHeaders(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    ),
  });
