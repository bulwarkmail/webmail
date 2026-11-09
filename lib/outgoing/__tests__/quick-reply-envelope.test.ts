import { describe, expect, it, vi } from 'vitest';
import { quickReplyEnvelope, saveQuickReplyDraft } from '../quick-reply-envelope';
import type { Email, Identity } from '@/lib/jmap/types';

const me: Identity = { id: 'id-me', name: 'Org Alice', email: 'org-alice@example.org', mayDelete: false };
const team: Identity = { id: 'id-team', name: 'Org Team', email: 'org-team@example.org', mayDelete: false };

const message = {
  id: 'm1',
  subject: 'Quarterly numbers',
  from: [{ name: 'Bob', email: 'org-bob@example.org' }],
  replyTo: [{ name: 'Bob (desk)', email: 'desk@example.org' }],
  to: [{ name: 'Team', email: 'org-team@example.org' }],
  cc: [],
  messageId: ['abc@example.org'],
  references: ['root@example.org'],
} as unknown as Email;

describe('quick reply addressing', () => {
  it('answers Reply-To from the identity the message was delivered to', () => {
    const envelope = quickReplyEnvelope(message, [me, team]);
    expect(envelope.recipients).toEqual(['desk@example.org']);
    expect(envelope.sendingIdentity?.id).toBe('id-team');
    expect(envelope.primaryIdentity?.id).toBe('id-me');
  });

  // #1353: list mail names the list in To; only Delivered-To shows the alias.
  it('sends from the identity in Delivered-To when To/Cc name none', () => {
    const listMail = {
      ...message,
      to: [{ name: 'Dev list', email: 'dev@lists.example.net' }],
      headers: { 'Delivered-To': ' org-team@example.org' },
    } as unknown as Email;
    expect(quickReplyEnvelope(listMail, [me, team]).sendingIdentity?.id).toBe('id-team');
  });
});

describe('saving a quick reply as a draft before an automatic sign-out', () => {
  it('saves the typed text as a threaded reply draft', async () => {
    const createDraft = vi.fn().mockResolvedValue('d1');
    await saveQuickReplyDraft({ client: { createDraft } as never, email: message, identities: [me, team], body: 'On it.', replyPrefix: 'Re:' });

    expect(createDraft).toHaveBeenCalledTimes(1);
    const [to, subject, body, , , identityId, fromEmail, draftId, , fromName, htmlBody, inReplyTo, references] = createDraft.mock.calls[0];
    expect(to).toEqual(['desk@example.org']);
    expect(subject).toBe('Re: Quarterly numbers');
    expect(body).toBe('On it.');
    expect(identityId).toBe('id-team');
    expect(fromEmail).toBe('org-team@example.org');
    expect(fromName).toBe('Org Team');
    expect(draftId).toBeUndefined();
    expect(htmlBody).toBeUndefined();
    expect(inReplyTo).toEqual(['abc@example.org']);
    expect(references).toEqual(['root@example.org', 'abc@example.org']);
  });
});
