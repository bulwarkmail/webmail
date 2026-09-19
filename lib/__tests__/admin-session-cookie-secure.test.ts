import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cookieSet = vi.fn();
vi.mock('next/headers', () => ({ cookies: async () => ({ set: cookieSet, get: () => undefined, delete: vi.fn() }) }));

describe('admin session cookie Secure flag', () => {
  beforeEach(() => { cookieSet.mockClear(); vi.stubEnv('SESSION_SECRET', 'a'.repeat(64)); });
  afterEach(() => vi.unstubAllEnvs());

  const secureFlagFor = async (request?: Request) => {
    const { setAdminSessionCookie } = await import('@/lib/admin/session');
    await setAdminSessionCookie(request);
    expect(cookieSet).toHaveBeenCalledTimes(1);
    return (cookieSet.mock.calls[0]![2] as { secure: boolean }).secure;
  };

  it('follows the request like the setup wizard: Secure behind an HTTPS proxy', async () => {
    expect(await secureFlagFor(new Request('http://app:3000/api/admin/auth', { headers: { 'x-forwarded-proto': 'https' } }))).toBe(true);
  });

  it('is not Secure on plain HTTP, so the browser keeps the cookie instead of dropping it silently', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(await secureFlagFor(new Request('http://app:3000/api/admin/auth'))).toBe(false);
  });

  it('keeps the production default when no request is passed', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(await secureFlagFor()).toBe(true);
  });
});
