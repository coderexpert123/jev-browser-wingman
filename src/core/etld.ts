import { getDomain } from 'tldts';

/**
 * Reduces a host to its registrable domain (eTLD+1), e.g.
 * `a.b.example.co.uk` -> `example.co.uk`. Falls back to the host itself
 * for IPs, `localhost` and hosts tldts cannot classify.
 */
export function registrableDomain(host: string): string {
  const domain = getDomain(host, { allowPrivateDomains: false });
  return domain ?? host;
}
