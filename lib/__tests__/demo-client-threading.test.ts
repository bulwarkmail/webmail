import { describe, expect, it } from 'vitest';
import { DemoJMAPClient } from '@/lib/demo/demo-client';
import { computeReplyThreadingHeaders } from '@/lib/email-threading';

// A server threads a reply by In-Reply-To and References. The demo gave every
// sent message a thread of its own, so a (quick) reply said "sent" but never
// showed up in the conversation it answered.
describe('DemoJMAPClient reply threading', () => {
  async function inboxMessage(client: DemoJMAPClient) {
    const inbox = (await client.getMailboxes()).find((m) => m.role === 'inbox')!;
    const { emails } = await client.getEmails(inbox.id);
    return emails.find((e) => e.messageId)!;
  }

  it('puts a sent reply into the thread of the message it answers', async () => {
    const client = new DemoJMAPClient();
    const original = await inboxMessage(client);
    const threading = computeReplyThreadingHeaders(original)!;

    const { emailId } = await client.sendEmail(
      [original.from![0].email], `Re: ${original.subject}`, 'Thanks!',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      threading.inReplyTo, threading.references,
    );

    const sent = await client.getEmail(emailId!);
    expect(sent?.threadId).toBe(original.threadId);
    expect((await client.getThreadEmails(original.threadId)).map((e) => e.id)).toContain(emailId);
  });

  it('keeps a saved reply draft in the thread too', async () => {
    const client = new DemoJMAPClient();
    const original = await inboxMessage(client);
    const threading = computeReplyThreadingHeaders(original)!;

    const draftId = await client.createDraft(
      [original.from![0].email], `Re: ${original.subject}`, 'Draft',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      threading.inReplyTo, threading.references,
    );

    const draft = await client.getEmail(draftId);
    expect(draft?.threadId).toBe(original.threadId);
    expect(draft?.inReplyTo).toEqual(threading.inReplyTo);
  });

  it('starts a new thread for a message that answers nothing', async () => {
    const client = new DemoJMAPClient();
    const original = await inboxMessage(client);

    const { emailId } = await client.sendEmail(['a@example.com'], original.subject ?? 'Hello', 'New message');

    const sent = await client.getEmail(emailId!);
    expect(sent?.threadId).toBeTruthy();
    expect(sent?.threadId).not.toBe(original.threadId);
  });
});
