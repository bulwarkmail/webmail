import { beforeEach, describe, expect, it, vi } from 'vitest';

// The browser side of the code hand-off (bulwarkmail.org/docs/development/mobile-handoff): parking a
// password sign-in, and confirming an SSO one, each give the app link with
// only the code. A failure gives no link at all, never the old fragment.

const apiFetch = vi.fn();
vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { confirmMobileHandoffCodeUrl, requestMobileHandoffCodeUrl } from '@/lib/auth/mobile-handoff-client';

const TARGET = 'bulwarkmobile://auth/callback';
const CODE = 'ab'.repeat(32);
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const payload = { server_url: 'https://mail.example.org', username: 'alice@example.org', password: 'secret' };

function respond(status: number, body: unknown) {
  apiFetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  apiFetch.mockReset();
});

describe('requestMobileHandoffCodeUrl', () => {
  it('parks the sign-in and links the app with the code only', async () => {
    respond(200, { code: CODE });
    const url = await requestMobileHandoffCodeUrl({ target: TARGET, challenge: CHALLENGE, state: 'm-1', payload });
    expect(url).toBe(`${TARGET}?code=${CODE}&state=m-1`);
    expect(url).not.toContain('secret');
    const [path, init] = apiFetch.mock.calls[0];
    expect(path).toBe('/api/auth/handoff/create');
    expect(JSON.parse(init.body)).toEqual({ code_challenge: CHALLENGE, state: 'm-1', ...payload });
  });

  it('gives no link when the server refuses', async () => {
    respond(429, { error: 'too_many_requests' });
    expect(await requestMobileHandoffCodeUrl({ target: TARGET, challenge: CHALLENGE, state: 'm-1', payload })).toBeNull();
  });

  it('gives no link when the request fails', async () => {
    apiFetch.mockRejectedValueOnce(new Error('offline'));
    expect(await requestMobileHandoffCodeUrl({ target: TARGET, challenge: CHALLENGE, state: 'm-1', payload })).toBeNull();
  });
});

describe('confirmMobileHandoffCodeUrl', () => {
  it('confirms the code and links the app with it', async () => {
    respond(200, { ok: true });
    expect(await confirmMobileHandoffCodeUrl({ target: TARGET, code: CODE, state: 'm-1' })).toBe(`${TARGET}?code=${CODE}&state=m-1`);
    expect(apiFetch.mock.calls[0][0]).toBe('/api/auth/handoff/confirm');
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ code: CODE });
  });

  it('gives no link for a code that is gone', async () => {
    respond(400, { error: 'invalid_code' });
    expect(await confirmMobileHandoffCodeUrl({ target: TARGET, code: CODE, state: 'm-1' })).toBeNull();
  });
});
