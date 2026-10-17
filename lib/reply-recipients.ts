export interface ReplyAddress {
  email?: string;
  name?: string;
}

export interface ReplySource {
  from?: ReplyAddress[];
  /** Addresses from the original message's Reply-To header. */
  replyToAddresses?: ReplyAddress[];
  to?: ReplyAddress[];
  cc?: ReplyAddress[];
}

export interface ReplyRecipientsResult {
  to: ReplyAddress[];
  cc: ReplyAddress[];
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeBase(email: string): string {
  const normalized = normalize(email);
  const at = normalized.indexOf('@');
  if (at <= 0) return normalized;

  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const plus = local.indexOf('+');

  return `${plus >= 0 ? local.slice(0, plus) : local}@${domain}`;
}

/**
 * Does `email` belong to the user? Matches exactly first, then with `+tag`
 * sub-addressing stripped (info+news@ is still info@).
 */
function isOwnAddress(email: string | undefined, ownEmails: string[]): boolean {
  if (!email?.trim()) return false;
  const exact = normalize(email);
  if (ownEmails.some((own) => normalize(own) === exact)) return true;
  const base = normalizeBase(email);
  return ownEmails.some((own) => normalizeBase(own) === base);
}

/**
 * The addresses a reply treats as the user's own: their identities plus the
 * account's login and primary address. Identities load from the server after
 * the app starts and aren't persisted, so a composer opened before they arrive
 * saw none and reply-all kept the user in To/Cc (#803). The account's
 * addresses are known from the start and cover the usual case until then.
 * A bare login name without a domain can't match an address, so it's skipped.
 */
export function ownReplyAddresses(
  identityEmails: (string | undefined | null)[],
  accountAddresses: (string | undefined | null)[] = [],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const email of [...identityEmails, ...accountAddresses]) {
    const trimmed = email?.trim();
    if (!trimmed || !trimmed.includes('@')) continue;
    const key = normalize(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/**
 * Is this a message the user themself sent? True when the From address is one
 * of their own identities - the case that shows up when browsing a thread and
 * replying to your own last message.
 */
export function isSelfSent(source: ReplySource | undefined, ownEmails: string[]): boolean {
  return isOwnAddress(source?.from?.[0]?.email, ownEmails);
}

/**
 * Work out the To/Cc a reply should open with.
 *
 * Normal case: reply goes to the Reply-To header if the original carried one,
 * else to From (RFC 5322). Reply-all adds the other original recipients,
 * minus the user's own addresses.
 *
 * Self-sent case (#703): replying to your own message inside a thread must
 * continue the conversation, not mail yourself. Gmail and Thunderbird address
 * the reply to the message's original recipients instead, so that's what we do
 * - the original To for reply, plus the original Cc for reply-all. Those
 * addresses were the user's own choice, so they're kept verbatim (no self-
 * filtering) and the Reply-To header is ignored, since answering your own
 * Reply-To would land the mail back in your inbox again.
 *
 * A self-sent message with no visible recipients (Bcc-only) has nothing to
 * continue to, so it falls back to the normal behaviour.
 *
 * `selfSentEmails` decides what counts as "self-sent" and defaults to
 * `ownEmails`. With several connected accounts, `ownEmails` holds every
 * account's addresses (so reply-all still drops all of them), but a message
 * one of those accounts sent to another is a received message for the
 * account it landed in: pass only that account's addresses here, or the
 * reply goes back to the original To - the account itself.
 */
export function buildReplyRecipients(
  source: ReplySource | undefined,
  mode: 'reply' | 'replyAll',
  ownEmails: string[],
  selfSentEmails: string[] = ownEmails,
): ReplyRecipientsResult {
  if (!source) return { to: [], cc: [] };

  const withEmail = (list: ReplyAddress[] | undefined) => (list ?? []).filter((r) => Boolean(r.email));

  const replyToList = withEmail(source.replyToAddresses);
  const externalReplyTo = replyToList.filter((r) => !isOwnAddress(r.email, ownEmails));

  if (!externalReplyTo.length && isSelfSent(source, selfSentEmails)) {
    const originalTo = withEmail(source.to);
    if (originalTo.length > 0) {
      return {
        to: originalTo,
        cc: mode === 'replyAll' ? withEmail(source.cc) : [],
      };
    }
  }

  const replyTarget = replyToList.length
    ? replyToList
    : (source.from?.[0]?.email ? [source.from[0]] : []);

  if (mode === 'reply') {
    return { to: replyTarget, cc: [] };
  }

  const others = (list: ReplyAddress[] | undefined) =>
    withEmail(list).filter((r) => !isOwnAddress(r.email, ownEmails));

  return {
    to: [...replyTarget, ...others(source.to)],
    cc: others(source.cc),
  };
}
