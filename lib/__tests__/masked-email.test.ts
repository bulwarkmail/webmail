import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ client: null as unknown, slot: 2, enabled: true }));
vi.mock('@/stores/auth-store', () => ({ useAuthStore: { getState: () => ({ client: state.client }) } }));
vi.mock('@/lib/auth/active-account-slot', () => ({ getActiveAccountSlot: () => state.slot }));
vi.mock('@/lib/stalwart/principal', () => ({ isStalwartJmapPassthroughEnabled: async () => state.enabled }));
vi.mock('@/lib/browser-navigation', () => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/lite', () => ({ IS_LITE: false }));

import { apiFetch } from '@/lib/browser-navigation';
import { bumpStoreEpoch } from '@/lib/store-epoch';
import { createMaskedEmailManager, maskedEmailErrorType, maskedEmailUnavailable } from '@/lib/stalwart/masked-email';

const namespaces = ['urn:stalwart:jmap', 'urn:inbuxa:jmap:registry'];
const fetchMock = vi.mocked(apiFetch);
const client = (namespace: string, account = 'personal') => ({
  getAccountId: () => account,
  hasAccountCapability: (cap: string, id: string) => cap === namespace && id === account,
  getCapabilities: () => ({ 'urn:ietf:params:jmap:core': { maxObjectsInGet: 2 } }),
});
const record = (id = 'mask') => ({ id, accountId: 'personal', email: `${id}@example.test`, forDomain: 'https://shop.example.test', description: null, enabled: true });
const wireRecord = (namespace: string, id = 'mask') => {
  const { enabled, ...rest } = record(id);
  return { ...rest, [namespace === namespaces[0] ? 'enable' : 'enabled']: enabled };
};
const reply = (method: string, result: unknown) => new Response(JSON.stringify({ methodResponses: [[method, result, 'masked']] }));
const calls = () => fetchMock.mock.calls.map(([, init]) => ({
  ...JSON.parse(String(init?.body)), slot: new Headers(init?.headers).get('X-JMAP-Cookie-Slot'),
}));
function backend() {
  fetchMock.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const [method, args] = body.methodCalls[0];
    if (method === 'x:MaskedEmail/query') return reply(method, { ids: args.position === 0 ? ['mask'] : [] });
    if (method === 'x:MaskedEmail/get') return reply(method, { accountId: 'personal', list: [wireRecord(body.using[1])] });
    return reply(method, args.create ? { created: { new: { id: 'created', email: 'created@example.test' } } } : { updated: { mask: null } });
  });
}
beforeEach(() => {
  bumpStoreEpoch();
  state.client = client(namespaces[1]);
  state.slot = 2;
  state.enabled = true;
  fetchMock.mockReset();
  backend();
});

describe.each(namespaces)('MaskedEmail contract: %s', namespace => {
  beforeEach(() => { state.client = client(namespace); });
  it('lists only personal records, creates and updates using the detected namespace', async () => {
    const enabledProperty = namespace === namespaces[0] ? 'enable' : 'enabled';
    const manager = createMaskedEmailManager()!;
    expect(await manager.list()).toEqual([record()]);
    expect(await manager.create({ description: 'Shop', forDomain: 'https://shop.example.test', accountId: 'foreign' } as never)).toBe('created');
    await manager.update('mask', { description: 'Updated', enabled: false, accountId: 'foreign', email: 'forged', destroy: ['mask'] } as never);
    const requests = calls();
    expect(requests.every(r => r.slot === '2' && r.using.join(',') === `urn:ietf:params:jmap:core,${namespace}`)).toBe(true);
    expect(requests.every(r => r.methodCalls[0][1].accountId === 'personal')).toBe(true);
    expect(requests[0].methodCalls[0]).toEqual(['x:MaskedEmail/query', { accountId: 'personal', filter: { accountId: 'personal' }, position: 0, limit: 50, calculateTotal: true }, 'masked']);
    expect(requests[1].methodCalls[0][1].properties).toContain(enabledProperty);
    expect(requests[1].methodCalls[0][1].properties).not.toContain(enabledProperty === 'enable' ? 'enabled' : 'enable');
    expect(requests[3].methodCalls[0][1]).toEqual({ accountId: 'personal', create: { new: { description: 'Shop', forDomain: 'https://shop.example.test', [enabledProperty]: true } } });
    expect(requests[4].methodCalls[0][1]).toEqual({ accountId: 'personal', update: { mask: { description: 'Updated', [enabledProperty]: false } } });
    expect(JSON.stringify(requests)).not.toContain('destroy');
  });
  it('sends no description as null on create and when it is cleared (#1641)', async () => {
    const enabledProperty = namespace === namespaces[0] ? 'enable' : 'enabled';
    const manager = createMaskedEmailManager()!;
    await manager.list();
    await manager.create({ description: '', forDomain: '' });
    await manager.update('mask', { description: '' });
    const requests = calls();
    expect(requests[3].methodCalls[0][1]).toEqual({ accountId: 'personal', create: { new: { description: null, forDomain: null, [enabledProperty]: true } } });
    expect(requests[4].methodCalls[0][1]).toEqual({ accountId: 'personal', update: { mask: { description: null } } });
  });
  it('handles server-limited query pages and respects maxObjectsInGet', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const [method, args] = JSON.parse(String(init?.body)).methodCalls[0];
      return reply(method, method.endsWith('/query') ? { ids: args.position === 0 ? ['a', 'b', 'c'] : args.position === 3 ? ['d'] : [], queryState: 'stable' } :
        { accountId: 'personal', list: args.ids.map((id: string) => wireRecord(namespace, id)) });
    });
    expect((await createMaskedEmailManager()!.list()).map(a => a.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(calls().filter(r => r.methodCalls[0][0].endsWith('/get')).map(r => r.methodCalls[0][1].ids)).toEqual([['a', 'b'], ['c'], ['d']]);
  });
  it('fails closed when the reply does not match the advertised field contract', async () => {
    fetchMock.mockResolvedValueOnce(reply('x:MaskedEmail/query', { ids: ['mask'] }));
    fetchMock.mockResolvedValueOnce(reply('x:MaskedEmail/get', { accountId: 'personal', list: [wireRecord(namespace === namespaces[0] ? namespaces[1] : namespaces[0])] }));
    await expect(createMaskedEmailManager()!.list()).rejects.toMatchObject({ type: 'invalidResponse' });
  });
});

describe.each(namespaces)('ordinary-user owner projection: %s', namespace => {
  beforeEach(() => { state.client = client(namespace); });
  const projected = () => {
    const { accountId: _owner, ...data } = wireRecord(namespace);
    return data;
  };
  function getResult(result: unknown) {
    fetchMock.mockResolvedValueOnce(reply('x:MaskedEmail/query', { accountId: 'personal', ids: ['mask'] }));
    fetchMock.mockResolvedValueOnce(reply('x:MaskedEmail/get', result));
    fetchMock.mockResolvedValueOnce(reply('x:MaskedEmail/query', { accountId: 'personal', ids: [] }));
  }
  it('accepts a native self-service record bound to the matching get response owner', async () => {
    getResult({ accountId: 'personal', list: [projected()] });
    expect(await createMaskedEmailManager()!.list()).toEqual([record()]);
  });
  it('rejects a missing get response owner even when a record claims the current owner', async () => {
    getResult({ list: [wireRecord(namespace)] });
    await expect(createMaskedEmailManager()!.list()).rejects.toMatchObject({ type: 'ownershipMismatch' });
  });
  it('rejects a foreign get response owner for a projected record', async () => {
    getResult({ accountId: 'foreign', list: [projected()] });
    await expect(createMaskedEmailManager()!.list()).rejects.toMatchObject({ type: 'ownershipMismatch' });
  });
  it.each(['foreign', null])('rejects a contradictory explicit record owner (%s)', async accountId => {
    getResult({ accountId: 'personal', list: [{ ...projected(), accountId }] });
    await expect(createMaskedEmailManager()!.list()).rejects.toMatchObject({ type: 'ownershipMismatch' });
  });
  it('rejects a projected record whose ID was not requested from the personal query', async () => {
    getResult({ accountId: 'personal', list: [{ ...projected(), id: 'unrequested' }] });
    await expect(createMaskedEmailManager()!.list()).rejects.toMatchObject({ type: 'invalidResponse' });
  });
});

describe.each(namespaces)('query completion: %s', namespace => {
  beforeEach(() => { state.client = client(namespace); });
  const projected = (id: string) => {
    const { accountId: _owner, ...data } = wireRecord(namespace, id);
    return { ...data, forDomain: null };
  };
  function serve(query: (args: { position: number; calculateTotal?: boolean }) => unknown) {
    fetchMock.mockImplementation(async (_url, init) => {
      const [method, args] = JSON.parse(String(init?.body)).methodCalls[0];
      return reply(method, method.endsWith('/query') ? query(args) : {
        accountId: 'personal', list: args.ids.map((id: string) => projected(id)),
      });
    });
  }
  it('finishes the complete native result before requesting a repeated first page', async () => {
    // Native Inbuxa consumes position during parameter validation. Its total
    // still counts the owner-filtered matches when calculateTotal is requested.
    serve(args => ({ ids: ['mask'], queryState: 'stable', position: 0,
      ...(args.calculateTotal ? { total: 1 } : {}) }));
    expect(await createMaskedEmailManager()!.list()).toEqual([{ ...record(), forDomain: null }]);
    expect(calls().map(r => r.methodCalls[0][0])).toEqual(['x:MaskedEmail/query', 'x:MaskedEmail/get']);
    expect(calls()[0].methodCalls[0][1]).toMatchObject({ calculateTotal: true, accountId: 'personal', filter: { accountId: 'personal' } });
    expect(calls().every(r => r.slot === '2' && r.using.includes(namespace))).toBe(true);
  });
  it('loads every server-limited page and stops exactly at the authoritative total', async () => {
    const all = ['a', 'b', 'c'];
    serve(args => ({ ids: all.slice(args.position, args.position + 1), total: all.length, queryState: 'stable' }));
    expect((await createMaskedEmailManager()!.list()).map(r => r.id)).toEqual(all);
    expect(calls().filter(r => r.methodCalls[0][0].endsWith('/query')).map(r => r.methodCalls[0][1].position)).toEqual([0, 1, 2]);
  });
  it('keeps normal pagination when a server omits total', async () => {
    serve(args => ({ ids: ['a', 'b'].slice(args.position, args.position + 1) }));
    expect((await createMaskedEmailManager()!.list()).map(r => r.id)).toEqual(['a', 'b']);
    expect(calls().filter(r => r.methodCalls[0][0].endsWith('/query')).map(r => r.methodCalls[0][1].position)).toEqual([0, 1, 2]);
  });
  it('still rejects repeated IDs when the advertised result is incomplete', async () => {
    serve(() => ({ ids: ['mask'], total: 2 }));
    await expect(createMaskedEmailManager()!.list()).rejects.toMatchObject({ type: 'invalidResponse' });
    expect(calls().filter(r => r.methodCalls[0][0].endsWith('/get'))).toHaveLength(1);
  });
  it('does not report a complete list when a page ends before the total', async () => {
    serve(args => ({ ids: args.position === 0 ? ['a'] : [], total: 2 }));
    await expect(createMaskedEmailManager()!.list()).rejects.toMatchObject({ type: 'invalidResponse' });
  });
  it('rejects a result-count change across pages', async () => {
    serve(args => ({ ids: args.position === 0 ? ['a'] : ['b'], total: args.position === 0 ? 2 : 3 }));
    await expect(createMaskedEmailManager()!.list()).rejects.toMatchObject({ type: 'listChanged' });
  });
  it('does not accept missing get records as a complete result', async () => {
    fetchMock.mockResolvedValueOnce(reply('x:MaskedEmail/query', { ids: ['mask'], total: 1 }));
    fetchMock.mockResolvedValueOnce(reply('x:MaskedEmail/get', { accountId: 'personal', list: [], notFound: ['mask'] }));
    await expect(createMaskedEmailManager()!.list()).rejects.toMatchObject({ type: 'listChanged' });
  });
  it('does not skip get authorization for an authoritative empty total', async () => {
    fetchMock.mockResolvedValueOnce(reply('x:MaskedEmail/query', { ids: [], total: 0 }));
    fetchMock.mockResolvedValueOnce(reply('error', { type: 'forbidden' }));
    const error = await createMaskedEmailManager()!.list().catch(e => e);
    expect(maskedEmailErrorType(error)).toBe('forbidden');
    expect(calls().map(r => r.methodCalls[0][0])).toEqual(['x:MaskedEmail/query', 'x:MaskedEmail/get']);
  });
  it.each(['envelope', 'record'])('still rejects a foreign %s owner at the advertised total', async where => {
    fetchMock.mockResolvedValueOnce(reply('x:MaskedEmail/query', { ids: ['mask'], total: 1 }));
    fetchMock.mockResolvedValueOnce(reply('x:MaskedEmail/get', {
      accountId: where === 'envelope' ? 'foreign' : 'personal',
      list: [{ ...projected('mask'), ...(where === 'record' ? { accountId: 'foreign' } : {}) }],
    }));
    await expect(createMaskedEmailManager()!.list()).rejects.toMatchObject({ type: 'ownershipMismatch' });
  });
  it.each([0, '1'])('rejects inconsistent or nonnumeric total (%s)', async total => {
    serve(() => ({ ids: ['mask'], total }));
    await expect(createMaskedEmailManager()!.list()).rejects.toMatchObject({ type: 'invalidResponse' });
  });
});

describe.each(namespaces)('empty-list availability gate: %s', namespace => {
  beforeEach(() => { state.client = client(namespace); });
  it('accepts an empty list only after get also succeeds', async () => {
    fetchMock.mockResolvedValueOnce(reply('x:MaskedEmail/query', { ids: [] }));
    fetchMock.mockResolvedValueOnce(reply('x:MaskedEmail/get', { accountId: 'personal', list: [] }));
    expect(await createMaskedEmailManager()!.list()).toEqual([]);
    expect(calls().map(r => r.methodCalls[0][0])).toEqual(['x:MaskedEmail/query', 'x:MaskedEmail/get']);
    expect(calls()[1].methodCalls[0][1]).toEqual({
      accountId: 'personal', ids: [],
      properties: ['id', 'accountId', 'email', 'forDomain', 'description', namespace === namespaces[0] ? 'enable' : 'enabled'],
    });
  });
  it.each(['forbidden', 'unknownMethod'])('rejects an empty query when get returns %s', async type => {
    fetchMock.mockResolvedValueOnce(reply('x:MaskedEmail/query', { ids: [] }));
    fetchMock.mockResolvedValueOnce(reply('error', { type }));
    const error = await createMaskedEmailManager()!.list().catch(e => e);
    expect(maskedEmailErrorType(error)).toBe(type);
    expect(calls().map(r => r.methodCalls[0][0])).toEqual(['x:MaskedEmail/query', 'x:MaskedEmail/get']);
  });
});

describe.each(namespaces)('MaskedEmail permissions and account isolation: %s', namespace => {
  beforeEach(() => { state.client = client(namespace); });
  it.each(['forbidden', 'unknownMethod', 'notImplemented'])('handles a read refusal (%s) without any write', async type => {
    fetchMock.mockResolvedValue(reply('error', { type }));
    const error = await createMaskedEmailManager()!.list().catch(e => e);
    expect(maskedEmailErrorType(error)).toBe(type);
    expect(maskedEmailUnavailable(error)).toBe(type !== 'forbidden');
    expect(calls()).toHaveLength(1);
  });
  const enterprise = 'This feature is only available in the Enterprise edition. Obtain your trial license at https://license.stalw.art/trial.';
  it.each(['query', 'get'])('counts the Enterprise-only refusal of %s as unavailable, not as a permission (#1624)', async step => {
    if (step === 'get') fetchMock.mockResolvedValueOnce(reply('x:MaskedEmail/query', { ids: [] }));
    fetchMock.mockResolvedValueOnce(reply('error', { type: 'forbidden', description: enterprise }));
    const error = await createMaskedEmailManager()!.list().catch(e => e);
    expect(maskedEmailErrorType(error)).toBe('forbidden');
    expect(maskedEmailUnavailable(error)).toBe(true);
  });
  it('keeps any other forbidden detail a permission problem', async () => {
    fetchMock.mockResolvedValue(reply('error', { type: 'forbidden', description: 'Missing permission sysMaskedEmailGet' }));
    const error = await createMaskedEmailManager()!.list().catch(e => e);
    expect(maskedEmailUnavailable(error)).toBe(false);
  });
  it.each(['forbidden', 'overQuota', 'rateLimit'])('surfaces per-object create refusal (%s) without a retry', async type => {
    fetchMock.mockResolvedValue(reply('x:MaskedEmail/set', { notCreated: { new: { type } } }));
    await expect(createMaskedEmailManager()!.create({ description: '', forDomain: '' })).rejects.toMatchObject({ type });
    expect(calls()).toHaveLength(1);
  });
  it('surfaces per-object update refusal and rejects ids that were not read as owned', async () => {
    const manager = createMaskedEmailManager()!;
    await expect(manager.update('foreign', { enabled: false })).rejects.toMatchObject({ type: 'ownershipMismatch' });
    expect(fetchMock).not.toHaveBeenCalled();
    await manager.list();
    fetchMock.mockResolvedValue(reply('x:MaskedEmail/set', { notUpdated: { mask: { type: 'forbidden' } } }));
    await expect(manager.update('mask', { enabled: false })).rejects.toMatchObject({ type: 'forbidden' });
  });
  it('rejects foreign records even if the server returns them', async () => {
    fetchMock.mockResolvedValueOnce(reply('x:MaskedEmail/query', { ids: ['mask'] }));
    fetchMock.mockResolvedValueOnce(reply('x:MaskedEmail/get', { accountId: 'personal', list: [{ ...record(), accountId: 'foreign' }] }));
    await expect(createMaskedEmailManager()!.list()).rejects.toMatchObject({ type: 'ownershipMismatch' });
  });
  it.each(['account', 'slot', 'epoch', 'client'])('drops delayed responses after a %s change and sends no follow-up', async change => {
    let release!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const manager = createMaskedEmailManager()!;
    const pending = manager.list();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    if (change === 'account') state.client = client(namespace, 'another');
    if (change === 'slot') state.slot = 5;
    if (change === 'epoch') bumpStoreEpoch();
    if (change === 'client') state.client = client(namespace);
    release(reply('x:MaskedEmail/query', { ids: ['mask'] }));
    await expect(pending).rejects.toMatchObject({ type: 'staleContext' });
    await expect(manager.create({ description: '', forDomain: '' })).rejects.toMatchObject({ type: 'staleContext' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('honours the operator gate without making a JMAP request', async () => {
    state.enabled = false;
    await expect(createMaskedEmailManager()!.list()).rejects.toMatchObject({ type: 'unsupported' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not infer support from session-wide capabilities', () => {
    state.client = { ...client('unsupported'), getCapabilities: () => ({ [namespace]: {} }) };
    expect(createMaskedEmailManager()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
