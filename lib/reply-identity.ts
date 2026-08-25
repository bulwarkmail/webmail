import type { Identity } from '@/lib/jmap/types';

interface ReplyRecipient {
  email?: string | null;
  name?: string | null;
}

interface ReplyRecipients {
  to?: ReplyRecipient[];
  cc?: ReplyRecipient[];
  bcc?: ReplyRecipient[];
}

function normalizeEmailAddress(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeBaseEmailAddress(email: string): string {
  const normalized = normalizeEmailAddress(email);
  const atIndex = normalized.indexOf('@');

  if (atIndex <= 0) {
    return normalized;
  }

  const localPart = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);
  const plusIndex = localPart.indexOf('+');

  return `${plusIndex >= 0 ? localPart.slice(0, plusIndex) : localPart}@${domain}`;
}

function domainOf(email: string): string {
  const at = email.indexOf('@');
  return at > 0 ? email.slice(at + 1).toLowerCase() : '';
}

export function findReplyIdentityId(
  identities: Identity[],
  recipients?: ReplyRecipients,
): string | null {
  if (identities.length === 0 || !recipients) {
    return null;
  }

  const receivedAddresses = [
    ...(recipients.to || []),
    ...(recipients.cc || []),
    ...(recipients.bcc || []),
  ]
    .map((recipient) => recipient.email?.trim())
    .filter((email): email is string => Boolean(email));

  if (receivedAddresses.length === 0) {
    return null;
  }

  const exactMatches = new Set(receivedAddresses.map(normalizeEmailAddress));
  const exactIdentity = identities.find((identity) => exactMatches.has(normalizeEmailAddress(identity.email)));
  if (exactIdentity) {
    return exactIdentity.id;
  }

  const baseMatches = new Set(receivedAddresses.map(normalizeBaseEmailAddress));
  const baseIdentity = identities.find((identity) => baseMatches.has(normalizeBaseEmailAddress(identity.email)));

  return baseIdentity?.id ?? null;
}

/**
 * Pick the identity to use for a NEW message started while viewing a specific
 * mailbox/account. Matches the active mailbox's address to a configured
 * identity (exact, then `+tag`-stripped) so composing from info@ defaults its
 * From to info@. Returns `null` when no address is given or none matches, so
 * the caller keeps the primary identity.
 */
export function findComposeIdentityId(
  identities: Identity[],
  accountEmail?: string | null,
): string | null {
  const email = accountEmail?.trim();
  if (identities.length === 0 || !email) {
    return null;
  }

  const exact = normalizeEmailAddress(email);
  const exactIdentity = identities.find((identity) => normalizeEmailAddress(identity.email) === exact);
  if (exactIdentity) {
    return exactIdentity.id;
  }

  const base = normalizeBaseEmailAddress(email);
  const baseIdentity = identities.find((identity) => normalizeBaseEmailAddress(identity.email) === base);

  return baseIdentity?.id ?? null;
}

/**
 * Address whose identity `findComposeIdentityId` should preselect, based on the
 * mailbox currently open.
 *
 * Selecting a shared/group folder in the "Shared" sidebar section does not move
 * the active account - a delegated mailbox has no separate login, it is reached
 * through the viewer's - so the composer fell back to the reaching login's
 * primary address and started every new message as the wrong sender. The owner
 * of the selected folder is the correct default there.
 *
 * `accountName` is the JMAP `Account.name`, which RFC 8620 describes as "e.g.,
 * the email address of the account". Servers that put a human label there
 * instead simply produce no identity match, and the caller keeps the primary
 * identity - exactly the previous behaviour. The `@` test keeps that intent
 * explicit rather than relying on the match to fail.
 */
export function resolveComposeAccountEmail(
  mailboxes: Array<{ id: string; isShared?: boolean; accountName?: string }>,
  selectedMailbox?: string | null,
  activeAccountEmail?: string | null,
): string | undefined {
  const current = selectedMailbox
    ? mailboxes.find((mailbox) => mailbox.id === selectedMailbox)
    : undefined;

  if (current?.isShared && current.accountName?.includes('@')) {
    return current.accountName;
  }

  return activeAccountEmail ?? undefined;
}

/**
 * Restore the identity a draft was composed with from its saved From. A draft
 * stores only the From address+name, not an identityId, so when two identities
 * share an address (a default + an alias with a different display name) the name
 * has to disambiguate — an email-only match picks the wrong one. Falls back to
 * email, then `+tag`-stripped email. Returns null when none match (caller keeps
 * the default). Pass the same identity list the composer renders (the flat
 * cross-account list when multi-account is on) so the returned id is usable
 * there.
 */
export function findDraftIdentityId(
  identities: Identity[],
  from?: { email?: string | null; name?: string | null } | null,
): string | null {
  const email = from?.email?.trim();
  if (identities.length === 0 || !email) {
    return null;
  }

  const wantEmail = normalizeEmailAddress(email);
  const wantName = (from?.name ?? '').trim();

  const nameAndEmail = identities.find(
    (i) => normalizeEmailAddress(i.email) === wantEmail && (i.name ?? '').trim() === wantName,
  );
  if (nameAndEmail) {
    return nameAndEmail.id;
  }

  const exact = identities.find((i) => normalizeEmailAddress(i.email) === wantEmail);
  if (exact) {
    return exact.id;
  }

  const wantBase = normalizeBaseEmailAddress(email);
  const base = identities.find((i) => normalizeBaseEmailAddress(i.email) === wantBase);
  return base?.id ?? null;
}

export interface ReplyFromResolution {
  /** Identity to use for JMAP `identityId` and the SMTP envelope MAIL FROM. */
  identityId: string;
  /**
   * Override for the outgoing `From:` header. Populated when the incoming
   * message was delivered to an address on a domain the user owns (by
   * identity) but that isn't itself a configured identity - typical
   * domain-catch-all deployments. When set, the composer should put this
   * address (and `overrideName`) in the message's From header while sending
   * through the chosen identity.
   */
  overrideEmail?: string;
  overrideName?: string;
}

/**
 * Pick the identity + optional header-From override for replying to a message.
 *
 * Decision order:
 *   1. If a recipient address exactly matches an identity, reply as that
 *      identity with no override.
 *   2. Else if a recipient matches an identity after stripping `+tag`
 *      sub-addressing, reply as that identity with no override.
 *   3. Else if a recipient address is on a domain that one of the identities
 *      uses, treat that recipient as a catch-all alias: return the matching
 *      identity + the recipient as a header-From override.
 *   4. Else return `null` (caller falls back to primary identity).
 */
export function resolveReplyFrom(
  identities: Identity[],
  recipients?: ReplyRecipients,
): ReplyFromResolution | null {
  if (identities.length === 0 || !recipients) {
    return null;
  }

  const received: { email: string; name: string | undefined }[] = [
    ...(recipients.to || []),
    ...(recipients.cc || []),
    ...(recipients.bcc || []),
  ].flatMap((r) => {
    const email = r.email?.trim();
    if (!email) return [];
    return [{ email, name: r.name?.trim() || undefined }];
  });

  if (received.length === 0) {
    return null;
  }

  const identityEmails = new Set(identities.map((i) => normalizeEmailAddress(i.email)));
  const identityBaseEmails = new Set(identities.map((i) => normalizeBaseEmailAddress(i.email)));

  const exactIdentity = identities.find((i) =>
    received.some((r) => normalizeEmailAddress(r.email) === normalizeEmailAddress(i.email)),
  );
  if (exactIdentity) {
    return { identityId: exactIdentity.id };
  }

  const baseIdentity = identities.find((i) =>
    received.some((r) => normalizeBaseEmailAddress(r.email) === normalizeBaseEmailAddress(i.email)),
  );
  if (baseIdentity) {
    return { identityId: baseIdentity.id };
  }

  const ownedDomains = new Set(identities.map((i) => domainOf(i.email)).filter(Boolean));

  const catchAll = received.find((r) => {
    const email = normalizeEmailAddress(r.email);
    if (identityEmails.has(email) || identityBaseEmails.has(normalizeBaseEmailAddress(email))) {
      return false;
    }
    return ownedDomains.has(domainOf(email));
  });

  if (catchAll) {
    const anchor = identities.find((i) => domainOf(i.email) === domainOf(catchAll.email)) || identities[0];
    return {
      identityId: anchor.id,
      overrideEmail: catchAll.email,
      overrideName: catchAll.name,
    };
  }

  return null;
}