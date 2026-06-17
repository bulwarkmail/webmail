// Shared test factories. Additive only — existing tests keep their inline
// factories; new tests can import these to avoid re-declaring the large
// Email/Mailbox literals. Keep minimal and cast through `unknown` so callers
// only specify the fields they assert on.
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

export const makeEmail = (over: Partial<Email> = {}): Email =>
  ({
    id: 'e1',
    threadId: 't1',
    receivedAt: '2026-01-01T00:00:00Z',
    subject: '',
    from: [],
    to: [],
    cc: [],
    keywords: {},
    mailboxIds: {},
    ...over,
  } as unknown as Email);

export const makeMailbox = (over: Partial<Mailbox> = {}): Mailbox =>
  ({
    id: 'mb1',
    name: 'Inbox',
    role: 'inbox',
    unreadEmails: 0,
    totalEmails: 0,
    ...over,
  } as unknown as Mailbox);

/** A bare fake JMAP client: only the methods you pass exist. */
export const makeFakeJmapClient = (over: Partial<IJMAPClient> = {}): IJMAPClient =>
  over as unknown as IJMAPClient;
