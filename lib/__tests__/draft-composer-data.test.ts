import { describe, expect, it } from 'vitest';
import { composerDataFromDraft, withReplyAllRecipients } from '../draft-composer-data';
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
