import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Email, Identity } from '@/lib/jmap/types';
import { computeReplyThreadingHeaders } from '@/lib/email-threading';
import { deliveryAddresses, findDraftIdentityId, findReplyIdentityId } from '@/lib/reply-identity';
import { buildReplyRecipients, isSelfSent } from '@/lib/reply-recipients';
import { buildReplySubject } from '@/lib/subject-prefix';

type ReplySource = Pick<Email, 'from' | 'replyTo' | 'to' | 'cc' | 'bcc' | 'headers'>;

export interface QuickReplyEnvelope {
  recipients: string[];
  /** The identity the reply goes out as, the primary one when none matches. */
  sendingIdentity: Identity | undefined;
  primaryIdentity: Identity | undefined;
}

/**
 * Who a quick reply goes to and from whom: the composer's addressing rules
 * (Reply-To over From; for our own messages in a thread, the original
 * recipients instead of ourselves, #703), from the address the message was
 * delivered to, or for our own message the identity it was sent from.
 *
 * Quick reply resolves the user's OWN identities only. It deliberately does
 * NOT take the domain catch-all `From:` rewrite that the full composer
 * offers: this surface is a bare text box with no From row, so a rewritten
 * From would be applied with nothing on screen to show it - or to correct
 * it.
 */
export function quickReplyEnvelope(email: ReplySource, identities: Identity[]): QuickReplyEnvelope {
  const ownIdentityEmails = identities.map((i) => i.email).filter(Boolean);
  const replySource = { from: email.from, replyToAddresses: email.replyTo, to: email.to, cc: email.cc };
  const recipients = quickReplyRecipients(email, identities).map((r) => r.email);
  const primaryIdentity = identities[0];
  const selfSentIdentityId = isSelfSent(replySource, ownIdentityEmails)
    ? findDraftIdentityId(identities, email.from?.[0])
    : null;
  const sendingIdentityId = selfSentIdentityId ?? findReplyIdentityId(identities, {
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    deliveredTo: deliveryAddresses(email.headers),
  });
  const sendingIdentity = (sendingIdentityId ? identities.find((i) => i.id === sendingIdentityId) : undefined) || primaryIdentity;
  return { recipients, sendingIdentity, primaryIdentity };
}

/**
 * The people a quick reply goes to, with their names, by the same rules as
 * quickReplyEnvelope: for the box's "Reply to Ben Carter…" placeholder.
 */
export function quickReplyRecipients(email: ReplySource, identities: Identity[]): { name?: string; email: string }[] {
  const ownIdentityEmails = identities.map((i) => i.email).filter(Boolean);
  const replySource = { from: email.from, replyToAddresses: email.replyTo, to: email.to, cc: email.cc };
  return buildReplyRecipients(replySource, 'reply', ownIdentityEmails).to
    .filter((r): r is typeof r & { email: string } => Boolean(r.email))
    .map((r) => ({ name: r.name || undefined, email: r.email }));
}

/**
 * Saves the text typed into a quick reply as a draft reply, before an
 * automatic sign-out (lib/compose-flush-registry.ts). Plain text, threaded
 * like the reply would be; the signature is added when it is sent.
 */
export async function saveQuickReplyDraft(input: {
  client: IJMAPClient;
  email: Email;
  identities: Identity[];
  body: string;
  replyPrefix: string;
}): Promise<void> {
  const { client, email, identities, body, replyPrefix } = input;
  const { recipients, sendingIdentity } = quickReplyEnvelope(email, identities);
  const threading = computeReplyThreadingHeaders({ messageId: email.messageId, references: email.references });
  await client.createDraft(
    recipients,
    buildReplySubject(email.subject || '', replyPrefix),
    body,
    undefined,
    undefined,
    sendingIdentity?.id,
    sendingIdentity?.email,
    undefined,
    undefined,
    sendingIdentity?.name || undefined,
    undefined,
    threading?.inReplyTo,
    threading?.references,
  );
}
