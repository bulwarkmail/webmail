import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagementCapability } from '@/lib/stalwart/management-capability';

vi.mock('@/lib/browser-navigation', () => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/auth/active-account-slot', () => ({
  getActiveAccountSlotHeaders: () => ({ 'X-JMAP-Cookie-Slot': '9' }),
}));
vi.mock('@/lib/lite', () => ({ IS_LITE: false }));

import { apiFetch } from '@/lib/browser-navigation';
import { stalwartJmap, type JmapMethodCall } from '@/lib/stalwart/jmap-passthrough';

const fetchMock = vi.mocked(apiFetch);
const calls: JmapMethodCall[] = [['x:AccountPassword/get', { accountId: 'own', ids: ['singleton'] }, '0']];

describe('management passthrough namespace isolation', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ methodResponses: [] }), { status: 200 }));
  });

  it.each<ManagementCapability>(['urn:stalwart:jmap', 'urn:inbuxa:jmap:registry'])(
    'sends exactly one namespace for the captured account: %s', async (capability) => {
      await stalwartJmap(calls, { slot: 2, management: { accountId: 'own', capability } });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/account/stalwart/jmap');
      expect(new Headers(init?.headers).get('X-JMAP-Cookie-Slot')).toBe('2');
      expect(JSON.parse(String(init?.body))).toEqual({
        using: ['urn:ietf:params:jmap:core', capability], methodCalls: calls,
      });
    },
  );

  it('preserves legacy Stalwart calls and their active cookie slot', async () => {
    await stalwartJmap(calls);
    const init = fetchMock.mock.calls[0][1];
    expect(new Headers(init?.headers).get('X-JMAP-Cookie-Slot')).toBe('9');
    expect(JSON.parse(String(init?.body)).using).toEqual(['urn:ietf:params:jmap:core', 'urn:stalwart:jmap']);
  });

  it('preserves explicit background slots for existing Stalwart callers', async () => {
    await stalwartJmap(calls, { slot: 0 });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('X-JMAP-Cookie-Slot')).toBe('0');
  });

  it('rejects a scoped request without its captured credential slot', async () => {
    await expect(stalwartJmap(calls, {
      management: { accountId: 'own', capability: 'urn:inbuxa:jmap:registry' },
    })).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a batch that mixes accounts before sending anything', async () => {
    await expect(stalwartJmap([...calls, ['x:ApiKey/query', { accountId: 'other' }, '1']], {
      slot: 2, management: { accountId: 'own', capability: 'urn:inbuxa:jmap:registry' },
    })).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never retries a refused write under another namespace', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unknownCapability' }), { status: 400 }));
    await expect(stalwartJmap([['x:ApiKey/set', { accountId: 'own', destroy: ['fixture'] }, '0']], {
      slot: 2, management: { accountId: 'own', capability: 'urn:inbuxa:jmap:registry' },
    })).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
