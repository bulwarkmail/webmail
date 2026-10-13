import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient } from '../jmap/client';
import type { CalendarEvent } from '../jmap/types';

// iMIP mail is created with its own Email/set; without a messageId the server
// synthesizes one from its hostname, which on a multi-domain server names
// another domain. It gets the same sender-domain Message-ID as other mail.

type MethodCall = [string, Record<string, unknown>, string];

function createClient(): JMAPClient {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, {
    apiUrl: 'https://jmap.example.com/api',
    accountId: 'account-1',
    username: 'user@example.com',
  });
  return client;
}

/** Answers the requests the iMIP senders make and records each created Email. */
function mockServer() {
  const emails: Array<Record<string, unknown>> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const { methodCalls } = JSON.parse((init as { body: string }).body) as { methodCalls: MethodCall[] };
    const methodResponses = methodCalls.map(([name, args, callId]) => {
      if (name === 'Mailbox/get') {
        return [name, { list: [{ id: 'mb-drafts', name: 'Drafts', role: 'drafts' }, { id: 'mb-sent', name: 'Sent', role: 'sent' }] }, callId];
      }
      if (name === 'Identity/get') {
        return [name, { list: [{ id: 'identity-1', email: 'organizer@example.org' }, { id: 'identity-2', email: 'guest@example.net' }] }, callId];
      }
      if (name === 'Email/set') {
        const create = (args.create ?? {}) as Record<string, Record<string, unknown>>;
        emails.push(...Object.values(create));
        return [name, { created: Object.fromEntries(Object.keys(create).map((id) => [id, { id: 'email-1' }])) }, callId];
      }
      if (name === 'EmailSubmission/set') {
        const created = Object.keys((args.create ?? {}) as object);
        return [name, { created: Object.fromEntries(created.map((id) => [id, { id: 'sub-1' }])) }, callId];
      }
      return ['error', { type: 'unknownMethod' }, callId];
    });
    const payload = { methodResponses };
    return {
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(payload)),
      json: () => Promise.resolve(payload),
    } as Response;
  });
  return emails;
}

const EVENT = {
  id: 'event-1',
  uid: 'uid-1@example.org',
  title: 'Meet',
  start: '2026-10-20T10:00:00',
  duration: 'PT1H',
  timeZone: 'Europe/London',
  participants: {
    o: { email: 'organizer@example.org', name: 'Organizer', roles: { owner: true, attendee: true } },
    g: { email: 'guest@example.net', name: 'Guest', roles: { attendee: true } },
  },
} as unknown as CalendarEvent;

function expectMessageIdIn(email: Record<string, unknown> | undefined, domain: string) {
  const ids = email?.messageId as string[] | undefined;
  expect(ids).toHaveLength(1);
  expect(ids![0]).toMatch(new RegExp(`^[^<>@\\s]+@${domain.replace(/\./g, '\\.')}$`));
}

describe('iMIP Message-ID', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sets it in the organizer\'s domain on invitations', async () => {
    const emails = mockServer();
    await createClient().sendImipInvitation(EVENT);
    expect(emails).toHaveLength(1);
    expectMessageIdIn(emails[0], 'example.org');
  });

  it('sets it in the organizer\'s domain on cancellations', async () => {
    const emails = mockServer();
    await createClient().sendImipCancellation({ ...EVENT, status: 'cancelled' } as CalendarEvent);
    expect(emails).toHaveLength(1);
    expectMessageIdIn(emails[0], 'example.org');
  });

  it('sets it in the attendee\'s domain on replies', async () => {
    const emails = mockServer();
    await createClient().sendImipReply({
      organizerEmail: 'organizer@example.org',
      attendeeEmail: 'guest@example.net',
      uid: 'uid-1@example.org',
      summary: 'Meet',
      dtStart: '2026-10-20T10:00:00',
      status: 'ACCEPTED',
    });
    expect(emails).toHaveLength(1);
    expectMessageIdIn(emails[0], 'example.net');
  });
});
