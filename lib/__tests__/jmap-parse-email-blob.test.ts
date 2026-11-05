import { describe, it, expect, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';

// An .eml opened from the desktop (desktop-p3-5) is uploaded and read with Email/parse.

type Call = [string, Record<string, unknown>, string];

function clientAnswering(answer: (args: Record<string, unknown>) => unknown) {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, { accountId: 'me' });
  const calls: Call[] = [];
  vi.spyOn(client as unknown as { request: (c: Call[]) => Promise<unknown> }, 'request')
    .mockImplementation(async (reqCalls: Call[]) => {
      const [method, args, id] = reqCalls[0];
      calls.push(reqCalls[0]);
      return { methodResponses: [[method, answer(args), id]] };
    });
  return { client, calls };
}

describe('parseEmailBlob', () => {
  it('asks Email/parse for what the reader shows, bodies included', async () => {
    const { client, calls } = clientAnswering(() => ({ parsed: {} }));
    await client.parseEmailBlob('b1');
    const [method, args] = calls[0];
    expect(method).toBe('Email/parse');
    expect(args).toMatchObject({ accountId: 'me', blobIds: ['b1'], fetchAllBodyValues: true });
    expect(args.properties).toEqual(expect.arrayContaining(['subject', 'from', 'bodyValues', 'attachments', 'headers', 'htmlBody', 'textBody']));
    // What only a stored message has isn't asked for.
    expect(args.properties).not.toContain('mailboxIds');
  });

  it('gives a message in no folder, with the blob as its id and its date as received', async () => {
    const { client } = clientAnswering(() => ({
      parsed: { b1: { subject: 'Hi', sentAt: '2026-11-03T09:00:00Z', size: 12, hasAttachment: false, headers: [{ name: 'Subject', value: ' Hi' }] } },
    }));
    const email = await client.parseEmailBlob('b1');
    expect(email).toMatchObject({ id: 'b1', blobId: 'b1', subject: 'Hi', mailboxIds: {}, receivedAt: '2026-11-03T09:00:00Z' });
    expect(email?.keywords.$seen).toBe(true);
  });

  it('null when the blob is no message', async () => {
    const { client } = clientAnswering(() => ({ parsed: {}, notParsable: ['b1'] }));
    await expect(client.parseEmailBlob('b1')).resolves.toBeNull();
  });
});
