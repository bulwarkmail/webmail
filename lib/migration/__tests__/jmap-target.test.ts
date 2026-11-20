// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { JmapMigrationTarget, retryAfterMs } from '../jmap-target';
import { TargetAuthError, TargetRateLimitError } from '../types';

const SESSION = {
  apiUrl: 'https://public.example.com/jmap/',
  uploadUrl: 'https://public.example.com/jmap/upload/{accountId}/',
  username: 'alice@example.com',
  capabilities: { 'urn:ietf:params:jmap:core': { maxSizeUpload: 1234 } },
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'A1', 'urn:ietf:params:jmap:calendars': 'A1', 'urn:ietf:params:jmap:sieve': 'A1' },
};

function fakeServer(answer: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const request = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/jmap/session')) return Response.json(SESSION);
    return answer(url, init);
  };
  return { calls, request };
}

describe('JmapMigrationTarget', () => {
  it('sends the job credential to the configured server and never asks for scheduling messages', async () => {
    const server = fakeServer((_url, init) => {
      const body = JSON.parse(String(init.body));
      expect(body.methodCalls[0][0]).toBe('CalendarEvent/set');
      return Response.json({ methodResponses: [['CalendarEvent/set', { created: { o0: { id: 'E1' } } }, '0']] });
    });
    const target = await JmapMigrationTarget.open({ serverUrl: 'http://stalwart:8080', authHeader: 'Basic abc', request: server.request });
    expect(target.maxSizeUpload()).toBe(1234);
    expect(await target.saveEvents([{ event: { uid: 'u1' } }])).toEqual([{ id: 'E1' }]);
    const post = server.calls.at(-1)!;
    // The advertised public host is rebased onto the configured one.
    expect(post.url).toBe('http://stalwart:8080/jmap/');
    expect(new Headers(post.init.headers).get('authorization')).toBe('Basic abc');
    expect(JSON.parse(String(post.init.body)).methodCalls[0][1]).toMatchObject({ accountId: 'A1', sendSchedulingMessages: false });
  });

  it('turns 429 into a pause with Retry-After and 401 into an auth error', async () => {
    let status = 429;
    const server = fakeServer(() => new Response('{}', { status, headers: { 'retry-after': '120' } }));
    const target = await JmapMigrationTarget.open({ serverUrl: 'http://stalwart:8080', authHeader: 'Basic abc', request: server.request });
    await expect(target.uploadBlob('x', 'message/rfc822')).rejects.toEqual(new TargetRateLimitError(120_000));
    expect(server.calls.at(-1)!.url).toBe('http://stalwart:8080/jmap/upload/A1/');
    status = 401;
    await expect(target.uploadBlob('x', 'message/rfc822')).rejects.toBeInstanceOf(TargetAuthError);
  });

  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterMs('30')).toBe(30_000);
    expect(retryAfterMs(new Date(Date.UTC(2026, 0, 1, 0, 1)).toUTCString(), Date.UTC(2026, 0, 1))).toBe(60_000);
    expect(retryAfterMs(null)).toBeNull();
  });
});
