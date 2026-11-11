/**
 * Who is outside the organisation, for the "External" sender chip and the
 * confirm before sending outside it (policy.json organisation.externalMail).
 *
 * Internal are the domains of the user's own identities plus the domains
 * the admin lists; a listed domain covers its subdomains (example.com
 * covers eu.example.com). With no internal domain known at all nobody can
 * be told apart, so nothing counts as external.
 *
 * Domains are compared in ASCII (punycode) form on both sides, so an IDN
 * the admin typed in Unicode matches the xn-- form a server delivers.
 *
 * The pure functions take everything as arguments; the context helpers
 * read one signed-in account's effective policy and identities.
 */

import { DEFAULT_ORGANISATION_POLICY, normalizeDomainList, type OrganisationPolicy } from '@/lib/admin/organisation-policy';
import { toAsciiDomain, toAsciiEmail } from '@/lib/idn';
import { usePolicyStore } from '@/stores/policy-store';
import { useAuthStore } from '@/stores/auth-store';
import { TRUSTED_SENDERS_BOOK_NAME, useContactStore } from '@/stores/contact-store';
import { policySubjectForClient } from '@/lib/admin/policy-subject';
import type { PolicySubject } from '@/lib/admin/policy-scopes';
import { cachedIdentitiesForAccount } from '@/hooks/use-pro-multi-account-identities';

export type ExternalMailPolicy = OrganisationPolicy['externalMail'];

/** The bare address of "Name <a@b>" or "a@b". */
function bareAddress(address: string | null | undefined): string {
  const raw = String(address ?? '').trim();
  const bracket = raw.match(/<([^<>]*)>\s*$/);
  return (bracket ? bracket[1] : raw).trim();
}

/** The domain of an address in lowercased ASCII form; '' without a usable one. */
export function addressDomain(address: string | null | undefined): string {
  const bare = bareAddress(address);
  const at = bare.lastIndexOf('@');
  if (at < 0) return '';
  const domain = bare.slice(at + 1).trim().replace(/\.+$/, '');
  return (domain && toAsciiDomain(domain)) || '';
}

/** The address as a lookup key: the domain in ASCII form, all lowercased. */
export function addressKey(address: string): string {
  return toAsciiEmail(bareAddress(address)).toLowerCase();
}

/** True when `domain` (ASCII) is one of `internal` or a subdomain of one. */
export function domainMatches(domain: string, internal: readonly string[]): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return internal.some((entry) => d === entry || d.endsWith(`.${entry}`));
}

/**
 * The domains of the user's identities, then the admin's, in ASCII form and
 * deduplicated. The identity domains come first so the list's size cap never
 * cuts them.
 */
export function internalDomains(identityEmails: readonly string[], policyDomains: readonly string[]): string[] {
  const own = identityEmails.map(addressDomain).filter(Boolean);
  return normalizeDomainList([...own, ...policyDomains]) ?? [];
}

/** Whether mail to this address leaves the organisation. An address without a domain isn't sendable and isn't counted. */
export function isExternalAddress(address: string, internal: readonly string[]): boolean {
  if (internal.length === 0) return false;
  const domain = addressDomain(address);
  return !!domain && !domainMatches(domain, internal);
}

export type RecipientField = 'to' | 'cc' | 'bcc';

export interface ExternalRecipient {
  address: string;
  domain: string;
  field: RecipientField;
}

/**
 * The recipients outside the organisation, each address once (in the first
 * field it appears in). `trusted` is asked for the rest, with the address as
 * addressKey makes it: with "trust contacts" on, a contact doesn't count.
 */
export function externalRecipients(
  recipients: { to: readonly string[]; cc: readonly string[]; bcc: readonly string[] },
  internal: readonly string[],
  trusted?: (key: string) => boolean,
): ExternalRecipient[] {
  const out: ExternalRecipient[] = [];
  const seen = new Set<string>();
  for (const field of ['to', 'cc', 'bcc'] as const) {
    for (const raw of recipients[field]) {
      const address = String(raw ?? '').trim();
      const key = addressKey(address);
      if (!address || seen.has(key)) continue;
      seen.add(key);
      if (!isExternalAddress(address, internal)) continue;
      if (trusted?.(key)) continue;
      out.push({ address, domain: addressDomain(address), field });
    }
  }
  return out;
}

export interface ExternalSender {
  address: string;
  /** ASCII domain; '' for an address without one. */
  domain: string;
}

/**
 * The From addresses that are outside the organisation. A message counts as
 * external when any of them is, and an address without a domain
 * ("CEO <ceo>") counts too: no organisation sends like that. A forged
 * internal From is not caught here; the sender check warns about that.
 */
export function externalSenders(
  from: readonly { email?: string | null }[] | null | undefined,
  internal: readonly string[],
): ExternalSender[] {
  if (!from || internal.length === 0) return [];
  const out: ExternalSender[] = [];
  for (const sender of from) {
    const address = String(sender?.email ?? '').trim();
    const domain = addressDomain(address);
    if (domain && domainMatches(domain, internal)) continue;
    out.push({ address, domain });
  }
  return out;
}

// ─── Per account ─────────────────────────────────────────────

/** What decides who is external for one signed-in account. */
export interface ExternalMailContext {
  /** That account's effective externalMail policy (its domain and group scopes applied). */
  policy: ExternalMailPolicy;
  /** That account's identities' addresses. */
  identityEmails: string[];
}

/** The active account: the effective policy and the identities in the stores. */
export function activeExternalMailContext(): ExternalMailContext {
  return {
    policy: usePolicyStore.getState().getOrganisation().externalMail ?? DEFAULT_ORGANISATION_POLICY.externalMail,
    identityEmails: (useAuthStore.getState().identities ?? []).map((identity) => identity.email),
  };
}

/** The internal domains of a context. */
export function contextInternalDomains(context: ExternalMailContext): string[] {
  return internalDomains(context.identityEmails, context.policy.domains);
}

type AccountClient = NonNullable<ReturnType<ReturnType<typeof useAuthStore.getState>['getClientForAccount']>>;
const subjects = new WeakMap<AccountClient, Promise<PolicySubject | null>>();
const identityLists = new WeakMap<AccountClient, Promise<string[]>>();

/** Whether Everyone or any domain or group scope turns this switch on. */
function switchOnAnywhere(key: 'senderLabel' | 'recipientWarning'): boolean {
  const raw = usePolicyStore.getState().rawPolicy;
  if (raw.organisation?.externalMail?.[key]) return true;
  return (raw.scopes ?? []).some((scope) => scope.policy.organisation?.externalMail?.[key] === true);
}

/** Whether `localAccountId` names another signed-in account than the active one. */
export function isOtherAccount(localAccountId: string | null | undefined): localAccountId is string {
  if (!localAccountId) return false;
  const auth = useAuthStore.getState();
  return localAccountId !== auth.activeAccountId && !!auth.getClientForAccount(localAccountId);
}

/**
 * The context of a signed-in account by its login id (AccountEntry id): a
 * message's own account in the unified inbox, or the account a message is
 * sent from. Its policy is resolved for its own subject, so a domain or
 * group scope of that account applies, and its own identities count. The
 * active account (or none given) reads the stores directly.
 *
 * With `need`, another account is only looked up when that switch can be on
 * for it: off everywhere in the policy costs no request, and off for that
 * account skips its identities.
 */
export async function externalMailContextFor(
  localAccountId?: string | null,
  need?: 'senderLabel' | 'recipientWarning',
): Promise<ExternalMailContext> {
  if (!isOtherAccount(localAccountId)) return activeExternalMailContext();
  if (need && !switchOnAnywhere(need)) return { policy: DEFAULT_ORGANISATION_POLICY.externalMail, identityEmails: [] };
  const client = useAuthStore.getState().getClientForAccount(localAccountId)!;
  let subject = subjects.get(client);
  if (!subject) {
    subject = policySubjectForClient(client).catch(() => null);
    subjects.set(client, subject);
  }
  const policy = usePolicyStore.getState().resolveFor(await subject).organisation?.externalMail
    ?? DEFAULT_ORGANISATION_POLICY.externalMail;
  if (need && !policy[need]) return { policy, identityEmails: [] };
  let identities = identityLists.get(client);
  if (!identities) {
    const cached = cachedIdentitiesForAccount(localAccountId);
    identities = cached
      ? Promise.resolve(cached.map((identity) => identity.email))
      : client.getIdentities().then((list) => list.map((identity) => identity.email)).catch(() => []);
    identityLists.set(client, identities);
  }
  return { policy, identityEmails: await identities };
}

/**
 * The addresses of the loaded contacts, as addressKey makes them. A card
 * that sits only in the "Trusted Senders" book is left out: that book is
 * the list of senders whose images load, not people the user writes to.
 */
export function contactAddresses(): Set<string> {
  const { contacts, addressBooks, trustedSendersBookId } = useContactStore.getState();
  const trustedBooks = new Set(addressBooks.filter((book) => book.name === TRUSTED_SENDERS_BOOK_NAME).map((book) => book.id));
  if (trustedSendersBookId) trustedBooks.add(trustedSendersBookId);
  const out = new Set<string>();
  for (const contact of contacts) {
    const books = Object.keys(contact.addressBookIds ?? {}).filter((id) => contact.addressBookIds?.[id]);
    if (books.length > 0 && books.every((id) => trustedBooks.has(id))) continue;
    for (const entry of Object.values(contact.emails ?? {})) {
      const address = entry?.address?.trim();
      if (address) out.add(addressKey(address));
    }
  }
  return out;
}
