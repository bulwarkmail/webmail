import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import { customHeaderProperties } from '../custom-headers';

// Headers a plugin adds in onTransformOutgoingEmail (a classification label,
// for one) go out with the message. Ones that would change the sender, clash
// with what the client writes itself or forge trace headers don't.

describe('customHeaderProperties', () => {
  it('turns plugin headers into JMAP header properties', () => {
    expect(customHeaderProperties({ 'X-Classification': 'Confidential', Sensitivity: 'Company-Confidential' })).toEqual({
      'header:X-Classification:asText': 'Confidential',
      'header:Sensitivity:asText': 'Company-Confidential',
    });
  });

  it('drops headers that say who sent the mail, how it travelled, or that the client writes', () => {
    expect(customHeaderProperties({
      From: 'boss@example.com',
      sender: 'boss@example.com',
      'Reply-To': 'x@evil.example',
      Bcc: 'spy@evil.example',
      'Message-ID': '<x@example.com>',
      'Content-Type': 'text/plain',
      Received: 'from somewhere',
      'Authentication-Results': 'mx; dkim=pass',
      'DKIM-Signature': 'v=1',
      'ARC-Seal': 'i=1',
      'Resent-From': 'a@example.com',
      'X-Priority': '1',
      Importance: 'high',
      'Disposition-Notification-To': 'me@example.com',
    })).toEqual({});
  });

  it('drops values with line breaks or control characters', () => {
    expect(customHeaderProperties({
      'X-Label': 'ok\r\nBcc: spy@evil.example',
      'X-Other': 'a\nb',
      'X-Nul': 'a\u0000b',
    })).toEqual({});
  });

  it('drops invalid names, empty or non-text values and repeats in another case', () => {
    expect(customHeaderProperties({
      'X Bad': 'space',
      'X:Bad': 'colon',
      'X-Ümlaut': 'non-ascii',
      'X-Empty': '   ',
      'X-Number': 5 as unknown as string,
      'X-Label': 'first',
      'x-label': 'second',
    })).toEqual({ 'header:X-Label:asText': 'first' });
  });

  it('ignores anything that is not a plain header map', () => {
    expect(customHeaderProperties(undefined)).toEqual({});
    expect(customHeaderProperties(['X-A'])).toEqual({});
    expect(customHeaderProperties('X-A: b')).toEqual({});
  });

  it('caps the number of headers', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`X-H${i}`, 'v']));
    expect(Object.keys(customHeaderProperties(many))).toHaveLength(20);
  });
});

describe('sendEmail with plugin headers', () => {
  interface CapturedRequest { methodCalls: Array<[string, Record<string, unknown>, string]> }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  function mockFlow() {
    const captured: CapturedRequest[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as CapturedRequest;
      captured.push(body);
      const methodResponses: unknown[] = [];
      for (const [method, args, callId] of body.methodCalls) {
        if (method === 'Mailbox/get') {
          methodResponses.push(['Mailbox/get', {
            list: [
              { id: 'mb-drafts', name: 'Drafts', role: 'drafts' },
              { id: 'mb-sent', name: 'Sent', role: 'sent' },
            ],
          }, callId]);
        } else if (method === 'Identity/get') {
          methodResponses.push(['Identity/get', { list: [{ id: 'identity-1', email: 'user@example.com' }] }, callId]);
        } else if (method === 'Email/set') {
          const key = Object.keys((args.create ?? {}) as Record<string, unknown>)[0];
          methodResponses.push(['Email/set', key ? { created: { [key]: { id: 'email-new-1' } } } : {}, callId]);
        } else if (method === 'EmailSubmission/set') {
          methodResponses.push(['EmailSubmission/set', { created: { '1': { id: 'sub-1' } } }, callId]);
        }
      }
      const payload = { methodResponses };
      return {
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(payload)),
        json: () => Promise.resolve(payload),
      } as Response;
    });
    return captured;
  }

  it('puts the plugin headers on the created message and leaves the sender alone', async () => {
    const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
    Object.assign(client, { apiUrl: 'https://jmap.example.com/api', accountId: 'account-1', username: 'user@example.com' });
    const captured = mockFlow();
    await client.sendEmail(
      ['to@example.com'], 'Subject', 'body',
      undefined, undefined, 'identity-1', 'user@example.com',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { headers: { 'X-Classification': 'Internal', From: 'boss@example.com' } },
    );
    const call = captured.flatMap(r => r.methodCalls).find(c => c[0] === 'Email/set' && c[1].create);
    const created = Object.values(call![1].create as Record<string, Record<string, unknown>>)[0];
    expect(created['header:X-Classification:asText']).toBe('Internal');
    expect(created['header:From:asText']).toBeUndefined();
    expect(created.from).toEqual([{ email: 'user@example.com' }]);
  });
});
