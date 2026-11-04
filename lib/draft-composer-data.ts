import type { ComposerDraftData } from '@/components/email/email-composer';
import { findDraftIdentityIdForLogin, type DraftSource } from '@/lib/draft-source';
import { getDraftComposerBody } from '@/lib/email-body-selection';
import type { Email, Identity, Mailbox } from '@/lib/jmap/types';
import { messagePriorityFromHeaders } from '@/lib/message-priority';
import { reopenedLabelChoice } from '@/lib/outgoing/classification';

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
    to: draft.to?.map((a) => a.email).filter(Boolean).join(', ') || '',
    cc: draft.cc?.map((a) => a.email).filter(Boolean).join(', ') || '',
    bcc: draft.bcc?.map((a) => a.email).filter(Boolean).join(', ') || '',
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
