import type { ComposerDraftData } from '@/components/email/email-composer';
import { findDraftIdentityIdForLogin, type DraftSource } from '@/lib/draft-source';
import { getDraftComposerBody } from '@/lib/email-body-selection';
import type { Email, Identity, Mailbox } from '@/lib/jmap/types';
import { messagePriorityFromHeaders } from '@/lib/message-priority';
import { reopenedLabelChoice } from '@/lib/outgoing/classification';
import { formatRecipient, parseRecipientList } from '@/lib/email-composer-utils';
import { buildReplyRecipients, type ReplySource } from '@/lib/reply-recipients';

/**
 * Reply all on a message whose reply draft is resumed: the draft keeps what
 * it has, and the people Reply all writes to that it doesn't have yet join
 * it (To to To, Cc to Cc), as Gmail does when a reply turns into a reply to
 * all. Before, Reply all opened the draft as it was (compose-p3-3).
 */
export function withReplyAllRecipients(data: ComposerDraftData, source: ReplySource, ownEmails: string[]): ComposerDraftData {
  const all = buildReplyRecipients(source, 'replyAll', ownEmails);
  const have = new Set([data.to, data.cc, data.bcc]
    .flatMap((list) => parseRecipientList(list))
    .map((r) => r.email.trim().toLowerCase()));
  const add = (list: string, extra: typeof all.to) => {
    const fresh = extra.filter((r) => {
      const key = r.email?.trim().toLowerCase();
      if (!key || have.has(key)) return false;
      have.add(key);
      return true;
    });
    return [list, ...fresh.map((r) => formatRecipient(r.name, r.email!))].filter(Boolean).join(', ');
  };
  const to = add(data.to, all.to);
  const cc = add(data.cc, all.cc);
  return { ...data, to, cc, showCc: data.showCc || cc.length > 0, kind: 'replyAll' };
}

/**
 * Whether a message may reopen as a draft from an id kept since last time. Sending
 * keeps the id, and a composer on it would replace, resend or delete the message. A
 * draft has `$draft` or sits in Drafts (a send undone comes back without the keyword);
 * and in Sent or Trash it's nothing to edit, whatever its keywords say.
 */
export function isRestorableDraft(
  draft: Pick<Email, 'keywords' | 'mailboxIds'>,
  mailboxes: Pick<Mailbox, 'id' | 'originalId' | 'role'>[],
): boolean {
  const roles = Object.keys(draft.mailboxIds ?? {}).map((id) => mailboxes.find((m) => m.id === id || m.originalId === id)?.role);
  if (roles.includes('sent') || roles.includes('trash')) return false;
  return !!draft.keywords?.$draft || roles.includes('drafts');
}

const addressList = (list: Email['to']): string =>
  (list ?? []).filter((a) => !!a.email).map((a) => formatRecipient(a.name ?? undefined, a.email!)).join(', ');

/**
 * What a composer starts from when a saved draft is opened: from the list, or from
 * last time the desktop app was running. `draft` has its full body.
 */
export function composerDataFromDraft(
  draft: Email,
  { accountId, localAccountId, identities, noSubject }: DraftSource & { identities: Identity[]; noSubject: string },
): ComposerDraftData {
  const { body, plainTextMode } = getDraftComposerBody(draft);
  return {
    // With their names, as they were picked: the chips showed bare addresses
    // and the mail went out without the names (compose-p3-6).
    to: addressList(draft.to),
    cc: addressList(draft.cc),
    bcc: addressList(draft.bcc),
    // Drafts saved before #1189 stored an empty subject as the composer's
    // "(No Subject)" placeholder; reopen those with an empty field.
    subject: draft.subject && draft.subject !== noSubject ? draft.subject : '',
    body,
    // Re-open in the format the draft was written in (#1022).
    plainTextMode,
    showCc: (draft.cc?.length || 0) > 0,
    showBcc: (draft.bcc?.length || 0) > 0,
    // Restore the identity the draft was composed with: the saved From (name and
    // address) against the list the composer renders, so a draft from a non-active
    // account, or one of two identities sharing an address, isn't reset to the default.
    selectedIdentityId: findDraftIdentityIdForLogin(identities, draft.from?.[0], localAccountId),
    subAddressTag: '',
    mode: 'compose',
    draftId: draft.id,
    draftAccountId: accountId,
    draftLocalAccountId: localAccountId,
    // A reply draft re-opens in compose mode; its threading headers must
    // come along or the reply leaves its thread.
    inReplyTo: draft.inReplyTo ?? undefined,
    references: draft.references ?? undefined,
    priority: messagePriorityFromHeaders(draft.headers),
    // A sent message brought back (Undo, Cancel and edit) has no draft
    // marker: its SIO-Label says which label it went out with.
    classification: reopenedLabelChoice(draft.headers, localAccountId),
    // Existing server-side attachments must ride along, or the composer
    // starts empty and the next save/send silently rebuilds the draft
    // without them (#849).
    attachments: (draft.attachments ?? [])
      .filter((a) => !!a.blobId)
      .map((a) => ({
        blobId: a.blobId,
        name: a.name,
        type: a.type,
        size: a.size,
        cid: a.cid,
        disposition: a.disposition,
      })),
  };
}
