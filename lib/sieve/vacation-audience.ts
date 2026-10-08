import type { VacationAudience } from '@/lib/jmap/sieve-types';

// A host name in the form the identities give it: labels of letters, digits
// and inner hyphens, at least two of them.
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Whether `value` is an audience Bulwark can write back as it reads. */
export function isValidVacationAudience(value: unknown): value is VacationAudience {
  if (!value || typeof value !== 'object') return false;
  const a = value as Record<string, unknown>;
  if (a.only !== 'internal' && a.only !== 'external') return false;
  return Array.isArray(a.domains) && a.domains.length > 0
    && a.domains.every((d) => typeof d === 'string' && DOMAIN.test(d));
}

/** The fields Bulwark stores, in a fixed order. */
export function normalizeVacationAudience(audience: VacationAudience): VacationAudience {
  return { only: audience.only, domains: audience.domains };
}

/** The domains of the given addresses, lower-cased, each once, in order. */
export function ownDomains(addresses: string[]): string[] {
  const domains: string[] = [];
  for (const address of addresses) {
    const at = address.lastIndexOf('@');
    const domain = at === -1 ? '' : address.slice(at + 1).trim().toLowerCase();
    if (DOMAIN.test(domain) && !domains.includes(domain)) domains.push(domain);
  }
  return domains;
}
