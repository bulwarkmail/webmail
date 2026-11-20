import { describe, expect, it } from 'vitest';
import { composerDataForEditAsNew, composerDataFromDraft, withReplyAllRecipients } from '../draft-composer-data';
import type { Email } from '../jmap/types';

const DRAFT = {
  id: 'd1', threadId: 't1', mailboxIds: { drafts: true }, keywords: { $draft: true },
  inReplyTo: ['m1@example.org'],
  from: [{ name: 'Me', email: 'me@example.org' }],
  to: [{ name: 'Compose Tester B', email: 'b@example.org' }],
  cc: [{ name: 'Doo, John', email: 'john@example.org' }, { email: 'plain@example.org' }],
  subject: 'Re: Plans', receivedAt: '2026-11-01T11:00:00Z', size: 10, hasAttachment: false,
  textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [], bodyValues: { '1': { value: 'Hi' } },
} as unknown as Email;

const open = (draft: Email) => composerDataFromDraft(draft, { identities: [], noSubject: '(no subject)' });

// compose-p3-6: a re-opened draft showed bare addresses and sent without the names.
describe('composerDataFromDraft', () => {
  it('keeps the names of the recipients', () => {
    const data = open(DRAFT);
    expect(data.to).toBe('Compose Tester B <b@example.org>');
    expect(data.cc).toBe('"Doo, John" <john@example.org>, plain@example.org');
  });
});

// compose-p3-3: Reply all on a message with a reply draft resumes the draft
// and adds the others Reply all writes to.
describe('withReplyAllRecipients', () => {
  const MESSAGE = {
    from: [{ name: 'Compose Tester B', email: 'b@example.org' }],
    to: [{ name: 'Me', email: 'me@example.org' }, { name: 'Carol', email: 'carol@example.org' }],
    cc: [{ name: 'Doo, John', email: 'JOHN@example.org' }, { name: 'Dave', email: 'dave@example.org' }],
  };

  it('adds the others to To and Cc, once each, never the user', () => {
    const data = withReplyAllRecipients(open(DRAFT), MESSAGE, ['me@example.org']);
    expect(data.to).toBe('Compose Tester B <b@example.org>, Carol <carol@example.org>');
    expect(data.cc).toBe('"Doo, John" <john@example.org>, plain@example.org, Dave <dave@example.org>');
    expect(data.showCc).toBe(true);
    expect(data.kind).toBe('replyAll');
    // The draft's own text and id stay.
    expect(data.draftId).toBe('d1');
  });

  it('adds nothing a recipient field already has', () => {
    const draft = { ...DRAFT, to: [{ email: 'b@example.org' }, { email: 'carol@example.org' }], cc: [], bcc: [{ email: 'dave@example.org' }, { email: 'john@example.org' }] } as unknown as Email;
    const data = withReplyAllRecipients(open(draft), MESSAGE, ['me@example.org']);
    expect(data.to).toBe('b@example.org, carol@example.org');
    expect(data.cc).toBe('');
  });
});

// #1781: "Edit as new" on a sent message.
describe('composerDataForEditAsNew', () => {
  const SENT = {
    id: 's1', threadId: 't1', mailboxIds: { sent: true }, keywords: { $seen: true, work: true },
    inReplyTo: ['m1@example.org'], references: ['m0@example.org', 'm1@example.org'],
    from: [{ name: 'Me', email: 'me@example.org' }],
    to: [{ name: 'Wrong Person', email: 'wrong@example.org' }],
    cc: [{ email: 'cc@example.org' }],
    bcc: [{ name: 'Boss', email: 'boss@example.org' }],
    subject: 'Re: Plans', receivedAt: '2026-11-01T11:00:00Z', size: 10, hasAttachment: true,
    textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [], bodyValues: { '1': { value: 'See the file.' } },
    attachments: [{ partId: '2', blobId: 'blob-2', name: 'plan.pdf', type: 'application/pdf', size: 1234, disposition: 'attachment' }],
  } as unknown as Email;
  const identities = [
    { id: 'id-other', name: 'Other', email: 'other@example.org' },
    { id: 'id-me', name: 'Me', email: 'me@example.org' },
  ] as never;

  it('fills a new message as the original went out', () => {
    const data = composerDataForEditAsNew(SENT, { identities, noSubject: '(no subject)' });
    expect(data.selectedIdentityId).toBe('id-me');
    expect(data.to).toBe('Wrong Person <wrong@example.org>');
    expect(data.cc).toBe('cc@example.org');
    expect(data.bcc).toBe('Boss <boss@example.org>');
    expect(data.showBcc).toBe(true);
    expect(data.subject).toBe('Re: Plans');
    expect(data.body).toContain('See the file.');
    expect(data.attachments).toEqual([
      expect.objectContaining({ blobId: 'blob-2', name: 'plan.pdf', type: 'application/pdf', size: 1234 }),
    ]);
  });

  it('is neither the sent message nor a reply to it', () => {
    const data = composerDataForEditAsNew(SENT, { identities, noSubject: '(no subject)' });
    expect(data.draftId).toBeNull();
    expect(data.draftAccountId).toBeUndefined();
    expect(data.inReplyTo).toBeUndefined();
    expect(data.references).toBeUndefined();
    expect(data.mode).toBe('compose');
    expect(data.kind).toBeUndefined();
  });

  it('marks the attachments with the login and account they live in, to be copied when sent from another', () => {
    const data = composerDataForEditAsNew(SENT, { identities, noSubject: '(no subject)', localAccountId: 'login-2', accountId: 'shared-acc' });
    expect(data.attachments?.[0]).toEqual(expect.objectContaining({ sourceAccountId: 'login-2', sourceJmapAccountId: 'shared-acc' }));
  });
});
