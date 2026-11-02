import type { Identity } from '@/lib/jmap/types';
import { appendHtmlSignature, appendPlainTextSignature } from '@/lib/signature-utils';
import { currentSignatureIdentity } from '@/lib/org/signature-state';
import { findUnfilledPlaceholders, type PlaceholderWords } from '@/lib/placeholder-check';
import { finalizeOutgoing, runPreSendChecks, type OutgoingBodies } from './send-pipeline';
import { runPluginSendCheck, type PluginSendCheckOutcome } from './plugin-send-check';
import { externalRecipientsFor } from './send-check-payload';
// Registers the organisation signature check and the disclaimer.
import '@/lib/org/outgoing';

/** A question the composer asks before sending, asked by quick reply too. */
export type QuickReplyQuestion =
  | { kind: 'placeholders'; found: string[] }
  | { kind: 'attachment'; keyword: string }
  | { kind: 'send' };

export interface QuickReplyQuestions {
  /** The fill-in words of the placeholder warning; null when it is off. */
  placeholderWords: PlaceholderWords[] | null;
  /** The keywords of the attachment reminder; null when it is off. */
  attachmentKeywords: string[] | null;
  /** "Confirm before sending" is on. */
  confirmSend: boolean;
  /** Resolves true to send anyway. */
  ask: (question: QuickReplyQuestion) => Promise<boolean>;
}

/**
 * The bodies a quick reply sends: the typed text with the signature, as
 * HTML too when the signature is HTML, after the same warnings, pre-send
 * checks and finalisers as the composer's send. Null when one stopped the
 * send. The organisation signature applies as in the composer
 * (`signatureIdentity` is what the reply would sign with on its own,
 * `sendingIdentity` the identity it goes out from). Plugins' send checks
 * (onBeforeEmailSend) run on it too, after the organisation signature and
 * before the disclaimer, as in the composer; `onSendCheckStopped` hears
 * why one stopped it.
 *
 * `insertSignature` is the user's reply/forward signature toggle: false
 * sends the bare typed text, with no signature of the user's own. The
 * organisation signature and disclaimer still apply - they are policy,
 * not the user's choice.
 */
export async function prepareQuickReply(input: {
  body: string;
  signatureIdentity: Identity | null | undefined;
  sendingIdentity?: Identity | null;
  separator: boolean;
  /** The user's signature auto-insert toggle for replies/forwards. */
  insertSignature?: boolean;
  to: string[];
  fromEmail?: string;
  identityId?: string;
  /** The reply's subject (without a classification prefix) and the original's Message-ID, for plugins. */
  subject?: string;
  inReplyTo?: string;
  questions?: QuickReplyQuestions;
  onSendCheckStopped?: (outcome: Exclude<PluginSendCheckOutcome, 'allowed'>) => void;
}): Promise<OutgoingBodies | null> {
  const { body, separator, questions } = input;

  // The composer's warnings, in its order. Only the typed text counts: the
  // subject and the signature are not the user's words here.
  if (questions?.placeholderWords) {
    const found = findUnfilledPlaceholders('', body, questions.placeholderWords);
    if (found.length > 0 && !(await questions.ask({ kind: 'placeholders', found }))) return null;
  }
  // A quick reply carries no attachments, so any keyword is a reminder.
  if (questions?.attachmentKeywords) {
    const lower = body.toLowerCase();
    const keyword = questions.attachmentKeywords.find(kw => kw.trim() && lower.includes(kw.toLowerCase()));
    if (keyword && !(await questions.ask({ kind: 'attachment', keyword }))) return null;
  }

  const signatureIdentity = currentSignatureIdentity(input.signatureIdentity, input.sendingIdentity ?? undefined);
  const insertSignature = input.insertSignature !== false;
  const text = insertSignature
    ? appendPlainTextSignature(body, signatureIdentity, { separator })
    : body;

  // When the identity has an HTML signature, send a matching HTML body so the
  // signature keeps its formatting; appendPlainTextSignature would otherwise
  // flatten it to plain text. Text-only identities keep the plain-text-only
  // behavior (no HTML part).
  const escapedBody = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  const html = insertSignature && signatureIdentity?.htmlSignature?.trim()
    ? appendHtmlSignature(`<div>${escapedBody}</div>`, signatureIdentity, { separator })
    : undefined;

  const context = {
    surface: 'quick-reply' as const,
    to: input.to,
    cc: [],
    bcc: [],
    fromEmail: input.fromEmail,
    identityId: input.identityId,
    sender: input.sendingIdentity
      ? { name: input.sendingIdentity.name, email: input.sendingIdentity.email }
      : undefined,
    mode: 'reply' as const,
    plainText: !html,
  };
  if (!(await runPreSendChecks(context))) return null;
  // Asked last, as in the composer, so an answered warning doesn't ask twice.
  if (questions?.confirmSend && !(await questions.ask({ kind: 'send' }))) return null;
  const bodies = finalizeOutgoing({ html, text }, context);
  // A quick reply used to skip plugins' send checks: a way around them.
  const outcome = await runPluginSendCheck(async () => ({
    to: input.to,
    cc: [],
    bcc: [],
    subject: input.subject ?? '',
    htmlBody: bodies.html ?? '',
    textBody: bodies.text,
    identityId: input.identityId ?? '',
    fromEmail: input.fromEmail,
    attachments: [],
    inReplyTo: input.inReplyTo,
    surface: 'quick-reply',
    mode: 'reply',
    // The quote isn't part of a quick reply: the typed text is all the user wrote.
    authoredText: body,
    externalRecipients: await externalRecipientsFor(context),
  }));
  if (outcome !== 'allowed') {
    input.onSendCheckStopped?.(outcome);
    return null;
  }
  return finalizeOutgoing(bodies, context, 'last');
}
