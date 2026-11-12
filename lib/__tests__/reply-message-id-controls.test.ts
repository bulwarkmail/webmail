// A Message-ID or References value of a received mail can hold a control character (both
// Stalwart versions hand back a bare CR in a received id as it is), and the server writes the ids
// of a new message into its In-Reply-To and References headers as they are. So an id with white
// space or a control character never goes into a reply: not where the composer and quick reply
// compute the headers, and not where the client builds the Email/set create (the last hop).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import { computeReplyThreadingHeaders, isThreadingMessageId } from '@/lib/email-threading';

const char = (code: number) => String.fromCharCode(code);
const CR = char(13);
const LF = char(10);
// As JMAP gives it for "Message-ID: <q1\rX-Inj-Cr: injected\r@evil.invalid>".
const HOSTILE = `q1${CR}X-Inj-Cr: injected${CR}@evil.invalid`;
const HOSTILE_CRLF = `q2${CR}${LF}Bcc: collector@attacker.invalid${CR}${LF}X: @evil.invalid`;
/** Tab, vertical tab, form feed, a lone LF, NEL (U+0085), LINE SEPARATOR (U+2028), a space, DEL. */
const VARIANTS = [9, 11, 12, 10, 0x85, 0x2028, 32, 0x7f].map((code) => `v${code.toString(16)}${char(code)}x@example.com`);

function hasControlOrSpace(value: string): boolean {
  return [...value].some((ch) => {
    const code = ch.charCodeAt(0);
    return code <= 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
  });
}

function createClient(): JMAPClient {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, { apiUrl: 'https://jmap.example.com/api', accountId: 'account-1', username: 'user@example.com' });
  return client;
}

interface CapturedRequest { methodCalls: Array<[string, Record<string, unknown>, string]> }

/** Answers Mailbox/get, Identity/get, Email/set and EmailSubmission/set; returns the request bodies. */
function mockServer() {
  const captured: CapturedRequest[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as { body: string }).body) as CapturedRequest;
    captured.push(body);
    const methodResponses: unknown[] = [];
    for (const [method, args, callId] of body.methodCalls) {
      if (method === 'Mailbox/get') {
        methodResponses.push(['Mailbox/get', { list: [{ id: 'mb-drafts', name: 'Drafts', role: 'drafts' }, { id: 'mb-sent', name: 'Sent', role: 'sent' }] }, callId]);
      } else if (method === 'Identity/get') {
        methodResponses.push(['Identity/get', { list: [{ id: 'identity-1', email: 'user@example.com', mayDelete: false }] }, callId]);
      } else if (method === 'Email/set') {
        const key = Object.keys((args.create ?? {}) as Record<string, unknown>)[0];
        methodResponses.push(['Email/set', key ? { created: { [key]: { id: 'email-new-1' } } } : {}, callId]);
      } else if (method === 'EmailSubmission/set') {
        methodResponses.push(['EmailSubmission/set', { created: { '1': { id: 'sub-1' } } }, callId]);
      }
    }
    const payload = { methodResponses };
    return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)), json: () => Promise.resolve(payload) } as Response;
  });
  return captured;
}

function createdIds(captured: CapturedRequest[]) {
  const call = captured.flatMap((request) => request.methodCalls).find((c) => c[0] === 'Email/set' && c[1].create)!;
  const email = Object.values(call[1].create as Record<string, Record<string, unknown>>)[0];
  return {
    inReplyTo: (email.inReplyTo as string[] | undefined) ?? [],
    references: (email.references as string[] | undefined) ?? [],
  };
}

describe('message ids of the mail being answered', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('never reach the reply headers with a control character (what the composer and quick reply compute)', () => {
    const headers = computeReplyThreadingHeaders({ messageId: [HOSTILE], references: ['root@example.com', HOSTILE_CRLF] });
    const ids = [...(headers?.inReplyTo ?? []), ...(headers?.references ?? [])];
    expect(ids.filter(hasControlOrSpace)).toEqual([]);
    // The clean ancestor is kept.
    expect(headers?.references ?? []).toContain('root@example.com');
  });

  it('drops each kind of white space and control character, and keeps the clean ids around it', () => {
    for (const bad of VARIANTS) {
      expect(isThreadingMessageId(bad)).toBe(false);
      const headers = computeReplyThreadingHeaders({ messageId: ['parent@example.com'], references: ['root@example.com', bad, 'mid@example.com'] });
      expect(headers).toEqual({
        inReplyTo: ['parent@example.com'],
        references: ['root@example.com', 'mid@example.com', 'parent@example.com'],
      });
    }
    // Brackets and the white space around an id are not part of it.
    expect(computeReplyThreadingHeaders({ messageId: ' <parent@example.com> ' })).toEqual({
      inReplyTo: ['parent@example.com'], references: ['parent@example.com'],
    });
    // Nothing left to thread by: no headers at all.
    expect(computeReplyThreadingHeaders({ messageId: [HOSTILE], references: [HOSTILE_CRLF] })).toBeNull();
  });

  it('never reach Email/set with a control character (the last hop, whatever the caller passed)', async () => {
    const client = createClient();
    const captured = mockServer();
    await client.sendEmail(
      ['recipient@example.com'], 'Re: figures', 'reply body',
      undefined, undefined, 'identity-1', 'user@example.com',
      undefined, undefined, undefined, undefined,
      [HOSTILE],
      ['root@example.com', HOSTILE, HOSTILE_CRLF, ...VARIANTS],
    );
    const { inReplyTo, references } = createdIds(captured);
    expect([...inReplyTo, ...references].filter(hasControlOrSpace)).toEqual([]);
    expect(inReplyTo).toEqual([]);
    expect(references).toEqual(['root@example.com']);
  });

  it('never reach a saved reply draft either, so sending it later carries none', async () => {
    const client = createClient();
    const captured = mockServer();
    await client.createDraft(
      ['recipient@example.com'], 'Re: figures', 'reply body',
      undefined, undefined, 'identity-1', 'user@example.com',
      undefined, undefined, undefined, undefined,
      ['<parent@example.com>', HOSTILE],
      ['root@example.com', HOSTILE_CRLF, ...VARIANTS],
    );
    expect(createdIds(captured)).toEqual({ inReplyTo: ['parent@example.com'], references: ['root@example.com'] });
  });
});
