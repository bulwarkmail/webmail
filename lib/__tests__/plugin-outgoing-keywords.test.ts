import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';
import type { InstalledPlugin, OutgoingEmail } from '../plugin-types';
import { cleanOutgoingKeywords, MAX_OUTGOING_KEYWORDS, outgoingKeywordProblem } from '../outgoing/outgoing-keywords';
import { hookResultFor } from '../plugin-sandbox/hook-payload';

// Keywords a plugin puts on a message the user sends (OutgoingEmail.keywords
// in onTransformOutgoingEmail): custom ones only, from a plugin with
// email:write, on the Email/set create so the Sent copy carries them. And the
// composer id in the same hook, which no plugin can change.

function plugin(perms: string[]): InstalledPlugin {
  return {
    id: 'akte', name: 'Akte', version: '1.0.0', author: 'test', description: '',
    type: 'hook', permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}

const MESSAGE: OutgoingEmail = {
  to: ['bob@example.com'], cc: [], bcc: [], subject: 'Mahnung', htmlBody: '', textBody: 'Hallo',
  identityId: 'id-1', attachments: [], composerId: 'composer-1', keywords: [],
};

describe('outgoing keywords: what may go on the message', () => {
  it('takes custom keywords in RFC 8621 syntax', () => {
    for (const keyword of ['akte', 'Akte-01/2026', 'case:4711', 'x.y_z', 'list[1', '#tag', 'a'.repeat(255)]) {
      expect(outgoingKeywordProblem(keyword)).toBeNull();
    }
  });

  it('refuses what RFC 8621 does not allow', () => {
    for (const keyword of ['', 'two words', 'tab\there', 'ä', 'a(b', 'a)b', 'a{b', 'a]b', 'a%b', 'a*b', 'a"b', 'a\\b', 'a'.repeat(256), 42, null]) {
      expect(outgoingKeywordProblem(keyword)).not.toBeNull();
    }
  });

  it('refuses system keywords except the star and Bulwark tags', () => {
    for (const keyword of ['$seen', '$Seen', '$draft', '$answered', '$forwarded', '$junk', '$notjunk', '$phishing', '$mdnsent', '$hasattachment', '$important', '$label:', '$labelx']) {
      expect(outgoingKeywordProblem(keyword)).toMatch(/system keyword/);
    }
    expect(outgoingKeywordProblem('$flagged')).toBeNull();
    expect(outgoingKeywordProblem('$Flagged')).toBeNull();
    expect(outgoingKeywordProblem('$label:clients')).toBeNull();
  });

  it('keeps each keyword once, case-insensitively, and at most ten', () => {
    const warn = vi.fn();
    const many = Array.from({ length: 12 }, (_, i) => `k${i}`);
    expect(cleanOutgoingKeywords(['Akte', 'akte', ...many], warn)).toEqual(['Akte', ...many.slice(0, MAX_OUTGOING_KEYWORDS - 1)]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(cleanOutgoingKeywords('akte', warn)).toEqual([]);
    expect(cleanOutgoingKeywords(undefined)).toEqual([]);
  });
});

describe('onTransformOutgoingEmail: what the host takes of a plugin\'s answer', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('takes keywords from a plugin with email:write, minus the ones it may not set', () => {
    const answer = { ...MESSAGE, keywords: ['akte-01/2026', '$seen', 'bad one'] };
    const taken = hookResultFor(plugin(['email:send', 'email:write']), 'onTransformOutgoingEmail', [MESSAGE], answer) as OutgoingEmail;
    expect(taken.keywords).toEqual(['akte-01/2026']);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[plugin:akte]'));
  });

  it('leaves the keywords as they were for a plugin without email:write', () => {
    const before = { ...MESSAGE, keywords: ['set-by-another'] };
    const answer = { ...before, subject: 'Changed', keywords: ['mine'] };
    const taken = hookResultFor(plugin(['email:send']), 'onTransformOutgoingEmail', [before], answer) as OutgoingEmail;
    expect(taken.keywords).toEqual(['set-by-another']);
    // The rest of its answer stands.
    expect(taken.subject).toBe('Changed');
    // Dropping the list doesn't drop the others' keywords either.
    const { keywords: _dropped, ...withoutList } = answer;
    void _dropped;
    expect((hookResultFor(plugin(['email:send']), 'onTransformOutgoingEmail', [before], withoutList) as OutgoingEmail).keywords).toEqual(['set-by-another']);
  });

  it('keeps the composer id, whatever the plugin answers', () => {
    const changed = hookResultFor(plugin(['email:send', 'email:write']), 'onTransformOutgoingEmail', [MESSAGE], { ...MESSAGE, composerId: 'other' }) as OutgoingEmail;
    expect(changed.composerId).toBe('composer-1');
    const { composerId: _gone, ...withoutId } = MESSAGE;
    void _gone;
    expect((hookResultFor(plugin(['email:send']), 'onTransformOutgoingEmail', [MESSAGE], withoutId) as OutgoingEmail).composerId).toBe('composer-1');
    // A forward has no composer: none can be made up either.
    expect((hookResultFor(plugin(['email:send']), 'onTransformOutgoingEmail', [withoutId], MESSAGE) as OutgoingEmail).composerId).toBeUndefined();
  });

  it('passes other hooks and non-object answers through untouched', () => {
    const answer = { keywords: ['x'] };
    expect(hookResultFor(plugin(['email:send']), 'onBeforeEmailSend', [MESSAGE], answer)).toBe(answer);
    expect(hookResultFor(plugin(['email:send']), 'onTransformOutgoingEmail', [MESSAGE], undefined)).toBeUndefined();
    expect(hookResultFor(plugin(['email:send']), 'onTransformOutgoingEmail', [MESSAGE], false)).toBe(false);
  });
});

describe('sendEmail: keywords on the created message', () => {
  interface CapturedRequest { methodCalls: Array<[string, Record<string, unknown>, string]> }

  function mockFlow(): CapturedRequest[] {
    const captured: CapturedRequest[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as CapturedRequest;
      captured.push(body);
      const methodResponses: unknown[] = [];
      for (const [method, args, callId] of body.methodCalls) {
        if (method === 'Mailbox/get') {
          methodResponses.push(['Mailbox/get', { list: [{ id: 'mb-drafts', role: 'drafts' }, { id: 'mb-sent', role: 'sent' }] }, callId]);
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
      return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)), json: () => Promise.resolve(payload) } as Response;
    });
    return captured;
  }

  function createClient(): JMAPClient {
    const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
    Object.assign(client, { apiUrl: 'https://jmap.example.com/api', accountId: 'account-1', username: 'user@example.com' });
    return client;
  }

  function sent(captured: CapturedRequest[]) {
    const calls = captured.flatMap((r) => r.methodCalls);
    const create = calls.find((c) => c[0] === 'Email/set' && c[1].create)!;
    const submission = calls.find((c) => c[0] === 'EmailSubmission/set')!;
    return {
      email: Object.values(create[1].create as Record<string, Record<string, unknown>>)[0],
      onSuccess: submission[1].onSuccessUpdateEmail as Record<string, Record<string, unknown>>,
    };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('sets them on the create, beside the host\'s own, and the move to Sent keeps them', async () => {
    const captured = mockFlow();
    await createClient().sendEmail(['bob@example.com'], 'Mahnung', 'Hallo', undefined, undefined, 'identity-1', 'user@example.com',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { keywords: ['akte-01/2026', '$flagged'] });
    const { email, onSuccess } = sent(captured);
    expect(email.keywords).toEqual({ 'akte-01/2026': true, $flagged: true, $seen: true, $draft: true });
    // Only $draft goes when it moves to Sent.
    expect(onSuccess['#1']).toMatchObject({ 'keywords/$draft': null });
    expect(Object.keys(onSuccess['#1']).filter((key) => key.startsWith('keywords/'))).toEqual(['keywords/$draft']);
  });

  it('checks them again: no system keyword gets through', async () => {
    const captured = mockFlow();
    await createClient().sendEmail(['bob@example.com'], 'Mahnung', 'Hallo', undefined, undefined, 'identity-1', 'user@example.com',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { keywords: ['$answered', '$junk', 'ok'] });
    expect(sent(captured).email.keywords).toEqual({ ok: true, $seen: true, $draft: true });
  });

  it('writes only the host\'s keywords without any', async () => {
    const captured = mockFlow();
    await createClient().sendEmail(['bob@example.com'], 'Mahnung', 'Hallo', undefined, undefined, 'identity-1', 'user@example.com');
    expect(sent(captured).email.keywords).toEqual({ $seen: true, $draft: true });
  });

  it('createDraft puts the composer\'s tags on the draft, beside the host\'s own', async () => {
    const captured = mockFlow();
    await createClient().createDraft(['bob@example.com'], 'Mahnung', 'Hallo', undefined, undefined, 'identity-1', 'user@example.com',
      undefined, undefined, undefined, undefined, undefined, undefined,
      { accountId: 'account-1', keywords: ['$label:work', '$answered'] });
    const create = captured.flatMap((r) => r.methodCalls).find((c) => c[0] === 'Email/set' && c[1].create)!;
    const draft = Object.values(create[1].create as Record<string, Record<string, unknown>>)[0];
    expect(draft.keywords).toEqual({ '$label:work': true, $seen: true, $draft: true });
  });
});
