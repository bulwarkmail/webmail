import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin, EmailReadView } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import type { Email, Mailbox } from '../jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall, PERM_PER_METHOD } from '../plugin-sandbox/host-api';
import { resetPluginRateLimits } from '../plugin-sandbox/host-api-input';
import { snapshotHostFeatures } from '../plugin-sandbox/host-features';
import { withAssistantRuntime } from '../plugin-sandbox/assistant/runtime';

function plugin(perms: string[], id = 'ai-assistant'): InstalledPlugin {
  return {
    id, name: 'AI Assistant', version: '2.2.0', author: 'test', description: '',
    type: 'hook', permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}

const ASSISTANT = plugin(['email:read']);
const call = (p: InstalledPlugin, ...args: unknown[]) => dispatchApiCall(p, 'email.getThread', args) as Promise<EmailReadView[]>;

const mail = (id: string, hoursAfter: number, subject: string, threadId = 't1'): Email => ({
  id, threadId, mailboxIds: { inbox: true }, keywords: {}, subject, from: [{ name: 'Bob', email: 'bob@example.org' }],
  receivedAt: new Date(Date.UTC(2026, 9, 1, hoursAfter)).toISOString(),
  textBody: [{ partId: '1', blobId: `b-${id}`, size: 1, type: 'text/plain' }],
  bodyValues: { 1: { value: `${subject} body` } },
} as unknown as Email);

// The server lists a thread's messages in its own order; the API sorts them.
const THREAD = [mail('m3', 30, 'Re: Re: Report'), mail('m1', 10, 'Report'), mail('m2', 20, 'Re: Report')];

let client: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  resetPluginRateLimits();
  client = {
    getEmail: vi.fn(async (id: string, accountId?: string) => {
      if (accountId === 'shared-acc') return id === 's1' ? mail('s1', 1, 'Team news', 'ts') : null;
      return THREAD.find((e) => e.id === id) ?? (id === 'lonely' ? mail('lonely', 5, 'Alone', 'tl') : null);
    }),
    getThreadEmails: vi.fn(async (threadId: string, accountId?: string) => {
      if (threadId === 't1' && !accountId) return THREAD;
      if (threadId === 'ts' && accountId === 'shared-acc') return [mail('s2', 2, 'Re: Team news', 'ts'), mail('s1', 1, 'Team news', 'ts')];
      if (threadId === 'big') return Array.from({ length: 60 }, (_, i) => mail(`b${i}`, i, `Part ${i}`, 'big'));
      return [];
    }),
    getSomeEmails: vi.fn(async (ids: string[], accountId?: string) => {
      const all = accountId === 'shared-acc' ? [mail('s1', 1, 'Team news', 'ts')] : [...THREAD, mail('lonely', 5, 'Alone', '')];
      return all.filter((e) => ids.includes(e.id));
    }),
    getThread: vi.fn(async (threadId: string, accountId?: string) => {
      if (threadId === 't1' && !accountId) return { id: 't1', emailIds: ['m1', 'm2', 'm3'] };
      if (threadId === 'ts' && accountId === 'shared-acc') return { id: 'ts', emailIds: ['s1', 's2'] };
      return null;
    }),
    getAccountId: vi.fn(() => 'acc1'),
    getMailboxes: vi.fn(async () => [{ id: 'shared-inbox', name: 'Team', isShared: true, accountId: 'shared-acc' } as unknown as Mailbox]),
  };
  useAuthStore.setState({ client: client as unknown as IJMAPClient });
  useEmailStore.setState({ selectedEmail: null, emails: [], mailboxes: [], selectedMailbox: '' });
});

afterEach(() => {
  useAuthStore.setState({ client: null });
});

describe('api.email.getThread', () => {
  it('is behind email:read, offered in the runtime and announced in the host features', async () => {
    expect(PERM_PER_METHOD['email.getThread']).toBe('email:read');
    await expect(call(plugin(['email:blob-read']), 'm2')).rejects.toThrow(/lacks permission "email:read"/);
    expect(client.getThreadEmails).not.toHaveBeenCalled();
    expect(snapshotHostFeatures()).toMatchObject({ threads: true });
    const calls: unknown[][] = [];
    const api = withAssistantRuntime({} as { email?: { getThread?: (...a: unknown[]) => unknown } }, async (method, args) => { calls.push([method, args]); return []; });
    await api.email?.getThread?.('m2');
    expect(calls).toEqual([['email.getThread', ['m2', undefined]]]);
  });

  it('returns every message of the conversation, oldest first, with their text', async () => {
    const thread = await call(ASSISTANT, 'm2');
    expect(thread.map((e) => [e.id, e.subject, e.text, e.accountId])).toEqual([
      ['m1', 'Report', 'Report body', 'acc1'],
      ['m2', 'Re: Report', 'Re: Report body', 'acc1'],
      ['m3', 'Re: Re: Report', 'Re: Re: Report body', 'acc1'],
    ]);
    // Only the newest 50 are fetched from the server.
    expect(client.getThreadEmails).toHaveBeenCalledWith('t1', undefined, { newest: 50 });
  });

  it('reads a shared account\'s conversation from that account', async () => {
    const thread = await call(ASSISTANT, 's1', { accountId: 'shared-acc' });
    expect(thread.map((e) => [e.id, e.accountId])).toEqual([['s1', 'shared-acc'], ['s2', 'shared-acc']]);
    expect(client.getThreadEmails).toHaveBeenCalledWith('ts', 'shared-acc', { newest: 50 });
  });

  it('refuses an account this login does not show, and a missing message', async () => {
    await expect(call(ASSISTANT, 'm2', { accountId: 'stranger' })).rejects.toThrow(/no message with id "m2"/);
    await expect(call(ASSISTANT, 'nope')).rejects.toThrow(/no message with id "nope"/);
    expect(client.getThreadEmails).not.toHaveBeenCalled();
  });

  it('gives the message alone when the server lists no thread, and at most the newest 50', async () => {
    expect((await call(ASSISTANT, 'lonely')).map((e) => e.id)).toEqual(['lonely']);
    client.getEmail.mockResolvedValueOnce(mail('b59', 59, 'Part 59', 'big'));
    const big = await call(ASSISTANT, 'b59');
    expect(big).toHaveLength(50);
    expect(big[0].id).toBe('b10');
    expect(big[49].id).toBe('b59');
  });

  it('checks its options and allows 60 reads a minute', async () => {
    await expect(call(ASSISTANT, 'm2', { threadId: 't1' })).rejects.toThrow(/unknown property "threadId"/);
    await expect(call(ASSISTANT, 42)).rejects.toThrow(/emailId must be a string/);
    resetPluginRateLimits();
    for (let i = 0; i < 60; i++) await call(ASSISTANT, 'm1');
    await expect(call(ASSISTANT, 'm1')).rejects.toThrow(/too many reads/);
  });
});

describe('api.email.getThreadCount', () => {
  const count = (p: InstalledPlugin, ...args: unknown[]) => dispatchApiCall(p, 'email.getThreadCount', args) as Promise<number>;

  it('is behind email:read and offered in the runtime', async () => {
    expect(PERM_PER_METHOD['email.getThreadCount']).toBe('email:read');
    await expect(count(plugin(['email:blob-read']), 'm2')).rejects.toThrow(/lacks permission "email:read"/);
    const calls: unknown[][] = [];
    const api = withAssistantRuntime({} as { email?: { getThreadCount?: (...a: unknown[]) => unknown } }, async (method, args) => { calls.push([method, args]); return 0; });
    await api.email?.getThreadCount?.('m2');
    expect(calls).toEqual([['email.getThreadCount', ['m2', undefined]]]);
  });

  it('counts the messages of the conversation without reading any of them', async () => {
    expect(await count(ASSISTANT, 'm2')).toBe(3);
    expect(client.getThread).toHaveBeenCalledWith('t1', undefined);
    expect(client.getEmail).not.toHaveBeenCalled();
    expect(client.getThreadEmails).not.toHaveBeenCalled();
    // A message without a thread is a conversation of one.
    expect(await count(ASSISTANT, 'lonely')).toBe(1);
  });

  it('counts in a shared account there, and refuses accounts this login does not show', async () => {
    expect(await count(ASSISTANT, 's1', { accountId: 'shared-acc' })).toBe(2);
    expect(client.getThread).toHaveBeenCalledWith('ts', 'shared-acc');
    await expect(count(ASSISTANT, 'm2', { accountId: 'stranger' })).rejects.toThrow(/no message with id "m2"/);
    expect(client.getSomeEmails).not.toHaveBeenCalledWith(['m2'], 'stranger');
    await expect(count(ASSISTANT, 'nope')).rejects.toThrow(/no message with id "nope"/);
  });

  it('has its own limit of 120 a minute, apart from getThread\'s', async () => {
    for (let i = 0; i < 60; i++) await call(ASSISTANT, 'm1');
    await expect(call(ASSISTANT, 'm1')).rejects.toThrow(/too many reads/);
    for (let i = 0; i < 120; i++) await count(ASSISTANT, 'm1');
    await expect(count(ASSISTANT, 'm1')).rejects.toThrow(/too many reads/);
  });
});
