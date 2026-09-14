import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      json: async () => data,
      status: init?.status ?? 200,
    }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/oauth/cookie-config', () => ({
  getCookieOptions: () => ({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 2592000 }),
}));

vi.mock('@/lib/auth/crypto', () => ({
  decryptPayload: () => ({
    state: 'state-1',
    code_verifier: 'verifier',
    redirect_uri: 'https://webmail.example/en/auth/callback',
    created_at: Date.now(),
  }),
}));

vi.mock('@/lib/oauth/token-exchange', () => ({
  exchangeCodeForTokens: vi.fn().mockResolvedValue({
    access_token: 'at',
    refresh_token: 'rt-new',
    expires_in: 3600,
  }),
  getRequiredConfig: vi.fn(),
  getTokenEndpoint: vi.fn(),
}));

class FakeCookies {
  store = new Map<string, string>();
  get(name: string) {
    const value = this.store.get(name);
    return value === undefined ? undefined : { name, value };
  }
  set(name: string, value: string) { this.store.set(name, value); }
  delete(name: string) { this.store.delete(name); }
}

let cookieStore: FakeCookies;
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));

async function complete(slot: number) {
  const { POST } = await import('@/app/api/auth/sso/complete/route');
  const request = { json: async () => ({ code: 'code', state: 'state-1', slot }) };
  const res = (await POST(request as Parameters<typeof POST>[0])) as unknown as { status: number };
  return res.status;
}

describe('sso complete route - refresh token lands in the slot the client asked for', () => {
  beforeEach(() => {
    vi.resetModules();
    cookieStore = new FakeCookies();
    cookieStore.set('sso_pending', 'encrypted');
    cookieStore.set('jmap_rt', 'rt-of-first-account');
  });

  it('writes a high slot instead of falling back to slot 0', async () => {
    expect(await complete(6)).toBe(200);

    expect(cookieStore.get('jmap_rt_6')?.value).toBe('rt-new');
    expect(cookieStore.get('jmap_rt')?.value).toBe('rt-of-first-account');
  });

  it('still writes slot 0 when asked for slot 0', async () => {
    expect(await complete(0)).toBe(200);

    expect(cookieStore.get('jmap_rt')?.value).toBe('rt-new');
  });
});
