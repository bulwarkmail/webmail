import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ client: null as unknown, slot: 0, enabled: true }));
const updateBasicPassword = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ client: state.client, updateBasicPassword }) },
}));
vi.mock('@/lib/stalwart/principal', () => ({
  isStalwartJmapPassthroughEnabled: async () => state.enabled,
}));
vi.mock('@/lib/auth/active-account-slot', () => ({
  getActiveAccountSlot: () => state.slot,
  getActiveAccountSlotHeaders: () => ({ 'X-JMAP-Cookie-Slot': String(state.slot) }),
}));
vi.mock('@/lib/browser-navigation', () => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/lite', () => ({ IS_LITE: false }));

import { apiFetch } from '@/lib/browser-navigation';
import { bumpStoreEpoch } from '@/lib/store-epoch';
import { useAccountSecurityStore } from '@/stores/account-security-store';

const STALWART = 'urn:stalwart:jmap';
const INBUXA = 'urn:inbuxa:jmap:registry';
const fetchMock = vi.mocked(apiFetch);
const client = (capability: string) => ({
  getAccountId: () => 'same-id',
  hasAccountCapability: (cap: string, accountId?: string) => cap === capability && accountId === 'same-id',
});
const authInfo = (ids: string[] = []) => [
  ['x:AccountPassword/get', { list: [{ otpAuth: {} }] }, '0'],
  ['x:AppPassword/query', { ids }, '1'],
  ['x:ApiKey/query', { ids: [] }, '2'],
];
const response = (methodResponses: unknown) => new Response(JSON.stringify({ methodResponses }), { status: 200 });
const requests = () => fetchMock.mock.calls.map(([, init]) => ({
  slot: new Headers(init?.headers).get('X-JMAP-Cookie-Slot'),
  ...JSON.parse(String(init?.body)) as { using: string[]; methodCalls: Array<[string, { accountId: string }, string]> },
}));

describe('Inbuxa Security management', () => {
  beforeEach(() => {
    bumpStoreEpoch();
    useAccountSecurityStore.getState().clearState();
    state.client = client(INBUXA);
    state.slot = 2;
    state.enabled = true;
    fetchMock.mockReset();
    updateBasicPassword.mockReset();
    fetchMock.mockImplementation(async (_url, init) => {
      const method = JSON.parse(String(init?.body)).methodCalls[0][0] as string;
      if (method.endsWith('/set')) {
        return response([[method, { updated: { singleton: null }, created: { new: { id: 'fixture', secret: 'synthetic-test-value' } }, destroyed: ['fixture'] }, '0']]);
      }
      return response(authInfo());
    });
  });

  it.each([STALWART, INBUXA])('detects Security support for %s', async (capability) => {
    state.client = client(capability);
    expect(await useAccountSecurityStore.getState().probe()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honours the operator passthrough feature gate', async () => {
    state.enabled = false;
    expect(await useAccountSecurityStore.getState().probe()).toBe(false);
  });

  it('rejects unsupported capabilities without sending management calls', async () => {
    state.client = client('urn:inbuxa:jmap');
    expect(await useAccountSecurityStore.getState().probe()).toBe(false);
    await useAccountSecurityStore.getState().fetchAuthInfo();
    expect(useAccountSecurityStore.getState().error).toContain('not supported');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('isolates namespaces and cancels stale follow-ups after an account switch', async () => {
    let release!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    const original = useAccountSecurityStore.getState().fetchAuthInfo();

    // Another server may use the very same JMAP account id.
    state.client = client(STALWART);
    state.slot = 5;
    bumpStoreEpoch();
    useAccountSecurityStore.getState().clearState();
    await useAccountSecurityStore.getState().fetchAuthInfo();
    release(response(authInfo(['fixture'])));
    await original;

    const sent = requests();
    expect(sent.map((r) => [r.slot, r.using])).toEqual([
      ['2', ['urn:ietf:params:jmap:core', INBUXA]],
      ['5', ['urn:ietf:params:jmap:core', STALWART]],
    ]);
    expect(sent.every((r) => r.methodCalls.every(([, args]) => args.accountId === 'same-id'))).toBe(true);
    expect(useAccountSecurityStore.getState().appPasswords).toEqual([]);
  });

  it('does not send follow-ups to a cookie slot reused by another server with the same account id', async () => {
    let release!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    const pending = useAccountSecurityStore.getState().fetchAuthInfo();
    state.client = client(STALWART);
    // Keep the same id AND slot: the epoch identifies the replaced context.
    bumpStoreEpoch();
    useAccountSecurityStore.getState().clearState();
    release(response(authInfo(['fixture'])));
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requests()[0].using).toEqual(['urn:ietf:params:jmap:core', INBUXA]);
    expect(useAccountSecurityStore.getState().appPasswords).toEqual([]);
  });

  it.each(['password', 'totp-enable', 'totp-disable', 'app-create', 'app-remove', 'key-create', 'key-remove'])(
    'uses Inbuxa for the mocked %s request', async (operation) => {
      const store = useAccountSecurityStore.getState();
      switch (operation) {
        case 'password': await store.changePassword('synthetic-old', 'synthetic-new'); break;
        case 'totp-enable': await store.enableTotp('synthetic-old', 'synthetic-otp-url', '000000'); break;
        case 'totp-disable': await store.disableTotp('synthetic-old', '000000'); break;
        case 'app-create': await store.createAppPassword({ description: 'fixture' }); break;
        case 'app-remove': await store.removeAppPassword('fixture'); break;
        case 'key-create': await store.createApiKey({ description: 'fixture' }); break;
        case 'key-remove': await store.removeApiKey('fixture'); break;
      }
      expect(fetchMock).toHaveBeenCalled();
      expect(requests().every((r) => r.slot === '2' && r.using.join(',') === `urn:ietf:params:jmap:core,${INBUXA}`)).toBe(true);
    },
  );

  it('does not replace the next account password context after an in-flight password change', async () => {
    let release!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    const pending = useAccountSecurityStore.getState().changePassword('synthetic-old', 'synthetic-new');
    state.client = client(STALWART);
    state.slot = 5;
    bumpStoreEpoch();
    release(response([['x:AccountPassword/set', { updated: { singleton: null } }, '0']]));
    await pending;
    expect(updateBasicPassword).not.toHaveBeenCalled();
    expect(requests()[0].slot).toBe('2');
  });

  it('keeps public-key queries and detail reads scoped, including an omitted response accountId', async () => {
    fetchMock
      .mockResolvedValueOnce(response([['x:PublicKey/query', { ids: ['fixture'] }, '0']]))
      .mockResolvedValueOnce(response([['x:PublicKey/get', {
        list: [{ id: 'fixture', description: 'fixture', key: 'synthetic-public-key', emailAddresses: {} }],
      }, '0']]));
    await useAccountSecurityStore.getState().fetchPublicKeys();
    expect(useAccountSecurityStore.getState().publicKeys[0].accountId).toBe('same-id');
    expect(requests().map((r) => [r.slot, r.using])).toEqual([
      ['2', ['urn:ietf:params:jmap:core', INBUXA]],
      ['2', ['urn:ietf:params:jmap:core', INBUXA]],
    ]);
  });
});
