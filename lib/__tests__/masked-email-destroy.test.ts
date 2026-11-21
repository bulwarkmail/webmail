import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ client: null as unknown, slot: 2 }));
vi.mock('@/stores/auth-store', () => ({ useAuthStore: { getState: () => ({ client: state.client }) } }));
vi.mock('@/lib/auth/active-account-slot', () => ({ getActiveAccountSlot: () => state.slot }));
vi.mock('@/lib/stalwart/principal', () => ({ isStalwartJmapPassthroughEnabled: async () => true }));
vi.mock('@/lib/browser-navigation', () => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/lite', () => ({ IS_LITE: false }));

import { apiFetch } from '@/lib/browser-navigation';
import { bumpStoreEpoch } from '@/lib/store-epoch';
import { createMaskedEmailManager } from '@/lib/stalwart/masked-email';

const namespaces = ['urn:stalwart:jmap', 'urn:inbuxa:jmap:registry'];
const fetchMock = vi.mocked(apiFetch);
const client = (namespace: string) => ({
  getAccountId: () => 'personal',
  hasAccountCapability: (cap: string, id: string) => cap === namespace && id === 'personal',
  getCapabilities: () => ({ 'urn:ietf:params:jmap:core': { maxObjectsInGet: 10 } }),
});
const reply = (method: string, result: unknown) => new Response(JSON.stringify({ methodResponses: [[method, result, 'masked']] }));
const calls = () => fetchMock.mock.calls.map(([, init]) => ({
  ...JSON.parse(String(init?.body)), slot: new Headers(init?.headers).get('X-JMAP-Cookie-Slot'),
}));
function reads() {
  fetchMock.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const method = body.methodCalls[0][0];
    return reply(method, method.endsWith('/query') ? { accountId: 'personal', ids: ['mask'], total: 1 } : {
      accountId: 'personal', list: [{ id: 'mask', email: 'mask@example.test', description: null, forDomain: null,
        [body.using[1] === namespaces[0] ? 'enable' : 'enabled']: true }],
    });
  });
}
beforeEach(() => {
  bumpStoreEpoch(); state.slot = 2; fetchMock.mockReset(); reads();
});

describe.each(namespaces)('native destroy contract and isolation: %s', namespace => {
  beforeEach(() => { state.client = client(namespace); });
  it('sends only one owned ID with captured account, namespace and cookie slot', async () => {
    const manager = createMaskedEmailManager()!;
    await manager.list();
    fetchMock.mockResolvedValue(reply('x:MaskedEmail/set', { accountId: 'personal', destroyed: ['mask'] }));
    await manager.destroy('mask');
    expect(calls()[2]).toEqual({ using: ['urn:ietf:params:jmap:core', namespace], slot: '2',
      methodCalls: [['x:MaskedEmail/set', { accountId: 'personal', destroy: ['mask'] }, 'masked']] });
    await expect(manager.destroy('mask')).rejects.toMatchObject({ type: 'ownershipMismatch' });
    await expect(manager.update('mask', { enabled: true })).rejects.toMatchObject({ type: 'ownershipMismatch' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('rejects unread or foreign IDs without a network call', async () => {
    await expect(createMaskedEmailManager()!.destroy('foreign')).rejects.toMatchObject({ type: 'ownershipMismatch' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['forbidden', 'notFound'])('surfaces notDestroyed %s without refreshing or retrying', async type => {
    const manager = createMaskedEmailManager()!;
    await manager.list();
    fetchMock.mockResolvedValue(reply('x:MaskedEmail/set', { accountId: 'personal', notDestroyed: { mask: { type } } }));
    await expect(manager.destroy('mask')).rejects.toMatchObject({ type });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it.each([
    {}, { accountId: 'foreign', destroyed: ['mask'] }, { destroyed: ['mask'] },
    { accountId: 'personal', destroyed: ['other'] }, { accountId: 'personal', destroyed: ['mask', 'mask'] },
    { accountId: 'personal', destroyed: ['mask'], notDestroyed: { mask: { type: 'forbidden' } } },
    { accountId: 'personal', notDestroyed: { mask: null } },
  ])('blocks retries after an unconfirmed or contradictory result (%j)', async result => {
    const manager = createMaskedEmailManager()!;
    await manager.list();
    fetchMock.mockResolvedValue(reply('x:MaskedEmail/set', result));
    await expect(manager.destroy('mask')).rejects.toMatchObject({ type: 'deleteUnconfirmed' });
    await expect(manager.destroy('mask')).rejects.toMatchObject({ type: 'deleteUnconfirmed' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('blocks network-error retries until an explicit successful read reconciles ownership', async () => {
    const manager = createMaskedEmailManager()!;
    await manager.list();
    fetchMock.mockRejectedValueOnce(new Error('synthetic connection loss'));
    await expect(manager.destroy('mask')).rejects.toMatchObject({ type: 'deleteUnconfirmed' });
    await expect(manager.destroy('mask')).rejects.toMatchObject({ type: 'deleteUnconfirmed' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    reads(); await manager.list();
    fetchMock.mockResolvedValueOnce(reply('x:MaskedEmail/set', { accountId: 'personal', destroyed: ['mask'] }));
    await manager.destroy('mask');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
  it.each(['forbidden', 'unknownMethod'])('handles a native method refusal (%s)', async type => {
    const manager = createMaskedEmailManager()!; await manager.list();
    fetchMock.mockResolvedValue(reply('error', { type }));
    await expect(manager.destroy('mask')).rejects.toMatchObject({ methodError: { type } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('blocks duplicate concurrent destroys while the first request is pending', async () => {
    const manager = createMaskedEmailManager()!; await manager.list();
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = manager.destroy('mask');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await expect(manager.destroy('mask')).rejects.toMatchObject({ type: 'deleteUnconfirmed' });
    release(reply('x:MaskedEmail/set', { accountId: 'personal', destroyed: ['mask'] }));
    await first;
  });
  it.each(['slot', 'epoch', 'client'])('rejects deletion after a %s change', async change => {
    const manager = createMaskedEmailManager()!; await manager.list();
    if (change === 'slot') state.slot = 4;
    if (change === 'epoch') bumpStoreEpoch();
    if (change === 'client') state.client = client(namespace);
    await expect(manager.destroy('mask')).rejects.toMatchObject({ type: 'staleContext' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('drops a delayed destroy result after the account changes, without a follow-up', async () => {
    const manager = createMaskedEmailManager()!; await manager.list();
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = manager.destroy('mask');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    state.client = client(namespace); state.slot = 4; bumpStoreEpoch();
    release(reply('x:MaskedEmail/set', { accountId: 'personal', destroyed: ['mask'] }));
    await expect(pending).rejects.toMatchObject({ type: 'deleteUnconfirmed' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
