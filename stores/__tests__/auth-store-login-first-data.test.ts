import { beforeEach, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// The first rows wait for the mailboxes and the folder's first page, and the
// sign-in used to ask for them only after it had flipped the app to signed in
// and its render had run. login() now asks for them first, then flips the app
// to signed in within the same task: the auth and account stores never show
// a moment in which they disagree.
vi.mock('@/lib/jmap/client', () => {
  class JMAPClient {
    constructor(public serverUrl: string, public username: string, public password: string) {}
    static withBearer() { throw new Error('not used'); }
    async connect() {}
    getSessionUsername() { return this.username; }
    getUsername() { return this.username; }
    async getIdentities() { return [{ id: 'a', email: this.username, name: this.username, mayDelete: false }]; }
    getAuthHeader() { return 'Basic eA=='; }
    onConnectionChange() {}
    onRateLimit() {}
    getRateLimitRemainingMs() { return 0; }
    supportsContacts() { return false; }
    supportsPrincipals() { return false; }
    supportsVacationResponse() { return false; }
    supportsCalendars() { return false; }
    supportsSieve() { return false; }
    disconnect() {}
    getAccountId() { return 'acct'; }
  }
  class RateLimitError extends Error {}
  return { JMAPClient, RateLimitError };
});
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null }));

import * as nav from '@/lib/browser-navigation';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';

const SERVER = 'https://mail.example.com';

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  useAuthStore.setState({ isAuthenticated: false, client: null, activeAccountId: null });
  vi.spyOn(nav, 'replaceWindowLocation').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === '/api/auth/verify') return new Response(JSON.stringify({ result: 'ok' }), { status: 200 });
    if (url.includes('/api/config')) return new Response(JSON.stringify(createConfig()), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
});

it('asks for the first mail data before it shows the app as signed in, in the same task', async () => {
  const seen: { signedIn: boolean; tick: number }[] = [];
  let tick = 0;
  const timer = setInterval(() => { tick++; }, 0);
  const prefetch = vi.fn(async () => {
    seen.push({ signedIn: useAuthStore.getState().isAuthenticated, tick });
  });
  useEmailStore.setState({ prefetchInitialData: prefetch } as never);
  let signedInAt = -1;
  const unsubscribe = useAuthStore.subscribe((s, prev) => { if (s.isAuthenticated && !prev.isAuthenticated) signedInAt = tick; });
  try {
    const ok = await useAuthStore.getState().login(SERVER, 'bob@example.com', 'pw', undefined, false);
    expect(ok).toBe(true);
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(seen[0].signedIn).toBe(false);
    // No task in between: the account and auth stores change together.
    expect(signedInAt).toBe(seen[0].tick);
  } finally {
    unsubscribe();
    clearInterval(timer);
  }
});
