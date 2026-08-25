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
 */
export function buildReplyRecipients(
  source: ReplySource | undefined,
  mode: 'reply' | 'replyAll',
  ownEmails: string[],
): ReplyRecipientsResult {
  if (!source) return { to: [], cc: [] };

  const withEmail = (list: ReplyAddress[] | undefined) => (list ?? []).filter((r) => Boolean(r.email));

  const replyToList = withEmail(source.replyToAddresses);
  const externalReplyTo = replyToList.filter((r) => !isOwnAddress(r.email, ownEmails));

  if (!externalReplyTo.length && isSelfSent(source, ownEmails)) {
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
