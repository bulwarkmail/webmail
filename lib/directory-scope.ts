/**
 * The admin policy's directory rules (`directorySameDomainOnly`,
 * `directoryHiddenLocalparts`) for every list of the server's accounts that
 * Bulwark shows: the contacts directory and recipient suggestions, sharing,
 * delegation, free/busy and the plugins' directory lookups. They narrow what
 * Bulwark shows, not what the server answers: Stalwart still lists every
 * account to a client that asks for them itself.
 */

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { loadPrincipalDirectory } from '@/lib/jmap/principal-directory';
import type { PrincipalListing } from '@/lib/jmap/types';
import { usePolicyStore } from '@/stores/policy-store';

export interface DirectoryScope {
  /**
   * Domains of the account's own addresses, lowercase; null without the
   * domain rule. Empty when the rule is on but no address of the account has
   * a domain: then the list keeps no one.
   */
  ownDomains: string[] | null;
  /** Account names (the part before the @) left out, lowercase. */
  hiddenLocalparts: string[];
}

const IDENTITY_DOMAINS_TTL_MS = 5 * 60 * 1000;
const identityDomains = new WeakMap<IJMAPClient, { loadedAt: number; domains: Promise<string[]> }>();

/** The domain of an address, lowercase; '' when it has none. */
function domainOf(address: string | null | undefined): string {
  const value = (address ?? '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  return at > 0 ? value.slice(at + 1) : '';
}

function domainsOf(identities: ReadonlyArray<{ email?: string | null }>): string[] {
  return identities.map((identity) => domainOf(identity.email)).filter(Boolean);
}

/**
 * The address a principal is matched by: its email, else a name that holds
 * one. Stalwart reports the account's name in both, so an account named
 * without a domain has no address to match.
 */
export function principalAddress(principal: { email?: string | null; name?: string | null }): string {
  const email = principal.email?.trim();
  if (email) return email;
  const name = principal.name?.trim() ?? '';
  return name.includes('@') ? name : '';
}

/**
 * The domains of the account's identities. Stalwart keeps one identity per
 * address of the account and adds or drops them as aliases come and go, so
 * these are the account's domains, aliases included. Asked for once per
 * client and kept for a few minutes. Not read from the auth store: server
 * routes import the contact store, and the auth store would pull modules
 * that only run in the browser into them (the production build refuses that).
 */
function identityDomainsOf(client: IJMAPClient): Promise<string[]> {
  const cached = identityDomains.get(client);
  if (cached && Date.now() - cached.loadedAt < IDENTITY_DOMAINS_TTL_MS) return cached.domains;
  const domains = Promise.resolve()
    .then(() => (typeof client.getIdentities === 'function' ? client.getIdentities() : []))
    .then(domainsOf, (): string[] => []);
  identityDomains.set(client, { loadedAt: Date.now(), domains });
  return domains;
}

/**
 * The rules for a list of this client's accounts, or null when the policy
 * sets none. `principals` is the listing at hand: the account's own entry in
 * it is one of its addresses too. The server sanitizes the policy fields;
 * Lite reads its policy.json as it is, so they are normalized here as well.
 */
export async function directoryScopeFor(
  client: IJMAPClient,
  principals: ReadonlyArray<{ id: string; email?: string | null; name?: string | null }> = [],
): Promise<DirectoryScope | null> {
  // The public policy from before the sign-in carries no directory rules.
  if (usePolicyStore.getState().partial) await usePolicyStore.getState().refreshIfPartial();
  const { directorySameDomainOnly, directoryHiddenLocalparts } = usePolicyStore.getState().policy;
  const hiddenLocalparts = (Array.isArray(directoryHiddenLocalparts) ? directoryHiddenLocalparts : [])
    .filter((part): part is string => typeof part === 'string')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (directorySameDomainOnly !== true) {
    return hiddenLocalparts.length > 0 ? { ownDomains: null, hiddenLocalparts } : null;
  }
  const ownDomains = new Set<string>();
  // Stalwart's master login is account%admin: the account decides.
  const login = domainOf(client.getUsername().split('%')[0]);
  if (login) ownDomains.add(login);
  for (const domain of await identityDomainsOf(client)) ownDomains.add(domain);
  const accountId = typeof client.getAccountId === 'function' ? client.getAccountId() : null;
  const self = principals.find((p) => p.id === accountId);
  const own = self ? domainOf(principalAddress(self)) : '';
  if (own) ownDomains.add(own);
  return { ownDomains: [...ownDomains], hiddenLocalparts };
}

/**
 * Whether an account stays in a list under the scope: its name before the @
 * isn't hidden and, with the domain rule, its address is in an own domain. An
 * entry without an address has no domain to stay by.
 */
export function inDirectoryScope(email: string | null | undefined, scope: DirectoryScope): boolean {
  const address = (email ?? '').trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (scope.hiddenLocalparts.includes(at >= 0 ? address.slice(0, at) : address)) return false;
  return scope.ownDomains === null || (at > 0 && scope.ownDomains.includes(address.slice(at + 1)));
}

/**
 * The client's principal listing (loadPrincipalDirectory) as Bulwark shows
 * it: with the admin policy's directory rules. Every list of the server's
 * accounts goes through this; a listing that can't be scoped counts as failed
 * rather than shown whole. Never rejects.
 */
export async function loadScopedPrincipalDirectory(client: IJMAPClient): Promise<PrincipalListing> {
  const listing = await loadPrincipalDirectory(client);
  try {
    const scope = await directoryScopeFor(client, listing.principals);
    if (!scope) return listing;
    return { ...listing, principals: listing.principals.filter((p) => inDirectoryScope(principalAddress(p), scope)) };
  } catch {
    return { principals: [], status: 'error' };
  }
}
