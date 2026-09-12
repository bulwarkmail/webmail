import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';
import { decryptVault, encryptVault, type VaultContents } from '@/lib/account-vault';
import { collectVault } from '@/lib/account-vault-client';

const { rejected, connected, requests, sessionRestore } = vi.hoisted(() => ({
  rejected: new Set<string>(), connected: [] as string[], requests: [] as { url: string; method?: string; body?: string }[],
  sessionRestore: { status: 200 },
}));
vi.mock('@/hooks/use-config', () => ({ fetchConfig: async () => ({ settingsSyncEnabled: false }) }));
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null }));
vi.mock('@/lib/browser-navigation', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/browser-navigation')>(),
  replaceWindowLocation: vi.fn(),
  apiFetch: async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method, body: init?.body as string });
    if (url.startsWith('/api/auth/session') && init?.method === 'PUT') {
      return { ok: sessionRestore.status === 200, status: sessionRestore.status, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  },
}));
vi.mock('@/lib/jmap/client', () => ({
  RateLimitError: class extends Error {},
  JMAPClient: class {
    constructor(readonly server: string, readonly username: string, readonly password: string) {}
    async connect() { if (rejected.has(this.username)) throw new Error('401'); connected.push(this.username); }
    disconnect() {}
    onConnectionChange() {}
    onRateLimit() {}
    getRateLimitRemainingMs() { return 0; }
    getAuthHeader() { return 'Basic ' + btoa(this.username + ':' + this.password); }
    getSessionUsername() { return this.username; }
    getUsername() { return this.username; }
    getServerUrl() { return this.server; }
    getIdentities() { return Promise.resolve([{ id: this.username, name: this.username, email: this.username, mayDelete: false }]); }
    supportsContacts() { return false; }
    supportsPrincipals() { return false; }
    supportsVacationResponse() { return false; }
    supportsCalendars() { return false; }
    supportsSieve() { return false; }
  },
}));

const owner = { username: 'owner@example.com', serverUrl: 'https://mail.example.com' };
const contents: VaultContents = { owner, defaultAccountId: 'box4@example.com@mail.example.com',
  accounts: [owner.username, ...Array.from({ length: 5 }, (_, i) => `box${i}@example.com`)].map(username => ({
    ...owner, username, password: `secret-for-${username}`, label: username, avatarColor: '#112233',
  })),
};
beforeEach(() => {
  rejected.clear(); connected.length = 0; requests.length = 0;
  sessionRestore.status = 200;
  vi.stubGlobal('crypto', webcrypto);
  vi.spyOn(performance, 'getEntriesByType').mockImplementation(type => type === 'navigation' ? [{ nextHopProtocol: 'h2' } as PerformanceResourceTiming] : []);
  localStorage.clear(); sessionStorage.clear();
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  useAuthStore.setState({ isAuthenticated: false, activeAccountId: null, client: null, username: null, serverUrl: null, isLoading: false });
});
afterEach(async () => {
  await useAuthStore.getState().logoutAll();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('one-password account restore', () => {
  it('imports metadata from a password archive without logging in, writing cookies or keeping passwords', async () => {
    const result = await useAuthStore.getState().restoreVault(contents, true, false);
    expect(result).toEqual({ connected: 0, failed: 0, pending: 6 });
    expect(connected).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(useAuthStore.getState().getAllConnectedClients().size).toBe(0);
    expect(useAccountStore.getState().accounts).toHaveLength(6);
    expect(useAccountStore.getState().accounts.every(a => !a.isConnected && !a.rememberMe && a.vaultManaged)).toBe(true);
    const metadata = collectVault(owner, false);
    expect(metadata.accounts.every(a => !('password' in a))).toBe(true);
    expect(() => collectVault(owner, true)).toThrow('accounts_disconnected');
    const persisted = localStorage.getItem('account-registry')!;
    for (const account of contents.accounts) expect(persisted).not.toContain(account.password!);
    await useAuthStore.getState().checkAuth();
    await vi.waitFor(() => expect(useAuthStore.getState().isLoading).toBe(false));
    expect(useAccountStore.getState().accounts).toHaveLength(6);
  });

  it('imports a password-free archive while preserving an existing live session', async () => {
    await useAuthStore.getState().restoreVault({ ...contents, accounts: [contents.accounts[0]], defaultAccountId: null }, true);
    const existing = useAuthStore.getState().client;
    const activeId = useAuthStore.getState().activeAccountId;
    const original = useAccountStore.getState().accounts[0];
    requests.length = 0; connected.length = 0;
    const metadata = { ...contents, accounts: contents.accounts.map(({ password: _password, ...account }) => account) };
    const result = await useAuthStore.getState().restoreVault(metadata, true);
    expect(result).toEqual({ connected: 1, failed: 0, pending: 5 });
    expect(requests).toHaveLength(0);
    expect(connected).toHaveLength(0);
    expect(useAuthStore.getState().client).toBe(existing);
    expect(useAuthStore.getState().activeAccountId).toBe(activeId);
    expect(useAccountStore.getState().accounts[0]).toEqual(original);
    expect(collectVault(owner, false).accounts).toEqual(metadata.accounts);
  });

  it('restores all six accounts into a clean browser with distinct slots and no local plaintext secrets', async () => {
    const envelope = await encryptVault(contents, 'a single archive password');
    const result = await useAuthStore.getState().restoreVault(await decryptVault(envelope, 'a single archive password', owner), true);
    expect(result).toEqual({ connected: 6, failed: 0, pending: 0 });
    expect(connected).toHaveLength(6);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().activeAccountId).toBe(contents.defaultAccountId);
    expect(useAuthStore.getState().getAllConnectedClients().size).toBe(6);
    const registry = useAccountStore.getState().accounts;
    expect(new Set(registry.map(a => a.cookieSlot)).size).toBe(6);
    expect(registry.every(a => a.isConnected && a.vaultManaged && a.rememberMe)).toBe(true);
    expect(collectVault(owner).accounts).toEqual(contents.accounts);
    const persisted = Object.keys(localStorage).map(k => localStorage.getItem(k)).join('');
    for (const account of contents.accounts) if (account.password) expect(persisted).not.toContain(account.password);
    expect(persisted).not.toContain('a single archive password');
    expect(requests.filter(r => r.url.startsWith('/api/auth/session?') && r.method === 'POST')).toHaveLength(6);
    // Subsequent SPA auth checks reuse the connected clients.
    await useAuthStore.getState().checkAuth();
    expect(useAccountStore.getState().accounts).toHaveLength(6);
  });

  it('keeps a failed account visible while connecting the others, without writing remembered sessions when disabled', async () => {
    rejected.add('box0@example.com');
    const result = await useAuthStore.getState().restoreVault(contents, false);
    expect(result).toEqual({ connected: 5, failed: 1, pending: 0 });
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    const failed = useAccountStore.getState().accounts.find(a => a.username === 'box0@example.com');
    expect(failed).toMatchObject({ isConnected: false, hasError: true, vaultManaged: true });
    expect(requests.filter(r => r.url.startsWith('/api/auth/session?') && r.method === 'POST')).toHaveLength(0);
    await useAuthStore.getState().checkAuth();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(useAccountStore.getState().accounts).toHaveLength(6);
    expect(() => collectVault(owner)).toThrow('accounts_disconnected');
  });

  it('rejects an oversized import before connecting or changing the registry on HTTP/1', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);
    await expect(useAuthStore.getState().restoreVault(contents, true)).rejects.toThrow('account_limit');
    expect(connected).toHaveLength(0);
    expect(useAccountStore.getState().accounts).toHaveLength(0);
  });

  it('preserves every archived account after a reload with expired session cookies', async () => {
    await useAuthStore.getState().restoreVault(contents, true);
    const persisted = JSON.parse(localStorage.getItem('account-registry')!).state;
    await useAuthStore.getState().logoutAll(); // drops all in-memory clients
    requests.length = 0;
    useAccountStore.setState({ ...persisted, accounts: persisted.accounts.map((a: object) => ({ ...a, isConnected: false })) });
    sessionRestore.status = 401;
    await useAuthStore.getState().checkAuth();
    await vi.waitFor(() => expect(useAccountStore.getState().accounts.every(a => a.hasError)).toBe(true));
    expect(useAccountStore.getState().accounts).toHaveLength(6);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(requests.filter(r => r.url.startsWith('/api/auth/session') && r.method === 'DELETE')).toHaveLength(0);
  });
});
