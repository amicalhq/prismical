import { X509Certificate } from 'node:crypto';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

/** Add OS-trusted roots (including corporate HTTPS proxies) to Node's defaults.
 * Keep extra CAs supplied by the launcher, and exclude expired or invalid roots.
 * Call before loading services that can open TLS connections. */
export function configureSystemTrustStore(): void {
  const now = Date.now();
  const certificates = [...getCACertificates('default'), ...getCACertificates('system')].filter(
    pem => {
      try {
        return Date.parse(new X509Certificate(pem).validTo) > now;
      } catch {
        return false;
      }
    }
  );
  setDefaultCACertificates(certificates);
}
