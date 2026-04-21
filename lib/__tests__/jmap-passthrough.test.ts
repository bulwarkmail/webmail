import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/lib/auth/active-account-slot', () => ({
  getActiveAccountSlotHeaders: vi.fn(() => ({ 'X-JMAP-Cookie-Slot': '0' })),
}));

import { stalwartJmap, requireResult, STALWART_JMAP_USING } from '@/lib/stalwart/jmap-passthrough';
import { apiFetch } from '@/lib/browser-navigation';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('stalwartJmap', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to /api/account/stalwart/jmap with the standard using array', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, { methodResponses: [] }));

    await stalwartJmap([['x:Account/get', { accountId: 'a', ids: ['a'] }, '0']]);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(url).toBe('/api/account/stalwart/jmap');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string);
    expect(body.using).toEqual(STALWART_JMAP_USING);
    expect(body.methodCalls).toEqual([['x:Account/get', { accountId: 'a', ids: ['a'] }, '0']]);
  });

  it('forwards the active account slot header', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, { methodResponses: [] }));

    await stalwartJmap([['x:Account/get', {}, '0']]);

    const init = mockedFetch.mock.calls[0][1];
    expect(init.headers['X-JMAP-Cookie-Slot']).toBe('0');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('returns methodResponses on success', async () => {
    const responses = [['x:AccountPassword/get', { list: [{ id: 'singleton' }] }, '0']];
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, { methodResponses: responses }));

    const result = await stalwartJmap([['x:AccountPassword/get', { accountId: 'a', ids: ['singleton'] }, '0']]);

    expect(result).toEqual(responses);
  });

  it('throws with status and message when the passthrough returns non-OK', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(401, { error: 'Not authenticated' }));

    await expect(stalwartJmap([['x:Account/get', {}, '0']])).rejects.toMatchObject({
      status: 401,
      message: 'Not authenticated',
    });
  });

  it('throws with HTTP fallback message when error body is unparseable', async () => {
    mockedFetch.mockResolvedValueOnce(new Response('oh no', { status: 500 }));

    await expect(stalwartJmap([['x:Account/get', {}, '0']])).rejects.toMatchObject({
      status: 500,
      message: 'HTTP 500',
    });
  });

  it('throws when first method response is a JMAP-level error', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, {
      methodResponses: [['error', { type: 'forbidden', description: 'Current secret must be provided' }, '0']],
    }));

    await expect(stalwartJmap([['x:AccountPassword/set', {}, '0']])).rejects.toMatchObject({
      status: 200,
      message: 'Current secret must be provided',
      methodError: { type: 'forbidden', description: 'Current secret must be provided' },
    });
  });

  it('falls back to error type when description is absent', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, {
      methodResponses: [['error', { type: 'unknownMethod' }, '0']],
    }));

    await expect(stalwartJmap([['x:Nope/get', {}, '0']])).rejects.toMatchObject({
      methodError: { type: 'unknownMethod' },
      message: 'unknownMethod',
    });
  });
});

describe('requireResult', () => {
  it('returns the arguments of the matching method', () => {
    const responses: Array<[string, Record<string, unknown>, string]> = [
      ['x:Account/get', { list: [{ id: 'a' }] }, '0'],
      ['x:AppPassword/query', { ids: ['p1'] }, '1'],
    ];

    const result = requireResult<{ ids: string[] }>(responses, 'x:AppPassword/query');
    expect(result.ids).toEqual(['p1']);
  });

  it('throws when the expected method is missing', () => {
    const responses: Array<[string, Record<string, unknown>, string]> = [
      ['x:Account/get', {}, '0'],
    ];

    expect(() => requireResult(responses, 'x:AppPassword/query')).toThrow(/x:AppPassword\/query/);
  });
});
