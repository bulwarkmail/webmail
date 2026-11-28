import type { VacationAudience } from '@/lib/jmap/sieve-types';
import { isPeriodBoundary } from '@/lib/sieve/period';

// A host name in the form the identities give it: labels of letters, digits
// and inner hyphens, at least two of them.
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Whether `value` is an audience Bulwark can write back as it reads. */
export function isValidVacationAudience(value: unknown): value is VacationAudience {
  if (!value || typeof value !== 'object') return false;
  const a = value as Record<string, unknown>;
  if (a.only !== 'internal' && a.only !== 'external') return false;
  if (a.activeFrom !== undefined && !isPeriodBoundary(a.activeFrom)) return false;
  if (a.activeUntil !== undefined && !isPeriodBoundary(a.activeUntil)) return false;
  return Array.isArray(a.domains) && a.domains.length > 0
    && a.domains.every((d) => typeof d === 'string' && DOMAIN.test(d));
}

/** The fields Bulwark stores, in a fixed order. */
export function normalizeVacationAudience(audience: VacationAudience): VacationAudience {
  return {
    only: audience.only,
    domains: audience.domains,
    ...(audience.activeFrom !== undefined ? { activeFrom: audience.activeFrom } : {}),
    ...(audience.activeUntil !== undefined ? { activeUntil: audience.activeUntil } : {}),
  };
}

/**
 * The audience with the vacation's period, whatever period it had (an empty
 * date leaves that end open). Without a period (null) it holds for as long
 * as the auto-reply is on.
 */
export function withAudiencePeriod(
  audience: Pick<VacationAudience, 'only' | 'domains'>,
  period: { from: string | null; until: string | null } | null,
): VacationAudience {
  return {
    only: audience.only,
    domains: audience.domains,
    ...(period?.from ? { activeFrom: period.from } : {}),
    ...(period?.until ? { activeUntil: period.until } : {}),
  };
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
