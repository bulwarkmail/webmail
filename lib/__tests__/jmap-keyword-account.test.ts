import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

// Regression coverage for the shared-account keyword write path (#281): keyword
// mutations (tags, $answered/$forwarded) on a unified-inbox message must target
// the email's owning account, not the reaching client's primary. Writing to the
// primary account silently no-ops server-side (JMAP returns notUpdated without
// throwing), so the keyword is lost on the next reload. toggleStar already
// threaded accountId through; updateEmailKeywords/setKeyword did not.

function createClient(): JMAPClient {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, {
    apiUrl: 'https://jmap.example.com/api',
    accountId: 'primary-account',
    username: 'user@example.com',
  });
  return client;
}

interface JMAPMethodCall {
  0: string;
  1: Record<string, unknown>;
  2: string;
}

function mockEmailSet() {
  const captured: JMAPMethodCall[] = [];
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as { body: string }).body) as { methodCalls: JMAPMethodCall[] };
    captured.push(...body.methodCalls);
    return new Response(JSON.stringify({ methodResponses: [['Email/set', { updated: {} }, '0']] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { captured, fetchSpy };
}

function patchFor(call: JMAPMethodCall, emailId: string): Record<string, unknown> {
  const update = call[1].update as Record<string, Record<string, unknown>>;
  return update[emailId];
}

describe('JMAP keyword writes route to the email account (#281)', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('updateEmailKeywords sends the explicit accountId', async () => {
    const client = createClient();
    const { captured } = mockEmailSet();
    await client.updateEmailKeywords('email-x', { '$label:work': true }, 'shared-account');
    expect(captured[0][0]).toBe('Email/set');
    expect(captured[0][1].accountId).toBe('shared-account');
  });

  it('updateEmailKeywords falls back to the primary account when none is given', async () => {
    const client = createClient();
    const { captured } = mockEmailSet();
    await client.updateEmailKeywords('email-x', { '$label:work': true });
    expect(captured[0][1].accountId).toBe('primary-account');
  });

  it('setKeyword sends the explicit accountId', async () => {
    const client = createClient();
    const { captured } = mockEmailSet();
    await client.setKeyword('email-x', '$answered', 'shared-account');
    expect(captured[0][0]).toBe('Email/set');
    expect(captured[0][1].accountId).toBe('shared-account');
  });

  it('setKeyword falls back to the primary account when none is given', async () => {
    const client = createClient();
    const { captured } = mockEmailSet();
    await client.setKeyword('email-x', '$answered');
    expect(captured[0][1].accountId).toBe('primary-account');
  });
});

describe('Email/set clears keywords with null, not false', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('markAsRead(false) removes $seen with null', async () => {
    const client = createClient();
    const { captured } = mockEmailSet();
    await client.markAsRead('email-x', false);
    const patch = patchFor(captured[0], 'email-x');
    expect(patch['keywords/$seen']).toBeNull();
    expect(patch['keywords/$seen']).not.toBe(false);
  });

  it('markAsRead(true) sets $seen to true', async () => {
    const client = createClient();
    const { captured } = mockEmailSet();
    await client.markAsRead('email-x', true);
    expect(patchFor(captured[0], 'email-x')['keywords/$seen']).toBe(true);
  });

  it('batchMarkAsRead(false) removes $seen with null for every id', async () => {
    const client = createClient();
    const { captured } = mockEmailSet();
    await client.batchMarkAsRead(['email-a', 'email-b'], false);
    for (const id of ['email-a', 'email-b']) {
      const patch = patchFor(captured[0], id);
      expect(patch['keywords/$seen']).toBeNull();
      expect(patch['keywords/$seen']).not.toBe(false);
    }
  });

  it('batchMarkAsRead(true) sets $seen to true for every id', async () => {
    const client = createClient();
    const { captured } = mockEmailSet();
    await client.batchMarkAsRead(['email-a', 'email-b'], true);
    for (const id of ['email-a', 'email-b']) {
      expect(patchFor(captured[0], id)['keywords/$seen']).toBe(true);
    }
  });

  it('toggleStar(false) removes $flagged with null', async () => {
    const client = createClient();
    const { captured } = mockEmailSet();
    await client.toggleStar('email-x', false);
    const patch = patchFor(captured[0], 'email-x');
    expect(patch['keywords/$flagged']).toBeNull();
    expect(patch['keywords/$flagged']).not.toBe(false);
  });

  it('toggleStar(true) sets $flagged to true', async () => {
    const client = createClient();
    const { captured } = mockEmailSet();
    await client.toggleStar('email-x', true);
    expect(patchFor(captured[0], 'email-x')['keywords/$flagged']).toBe(true);
  });
});
