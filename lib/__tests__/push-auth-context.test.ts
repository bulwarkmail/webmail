import { beforeEach, describe, expect, it, vi } from 'vitest';

// The context cookie lasts as long as the browser session. With every window
// closed and the browser started again by a push, only the remembered session
// is left, and the worker has to make do with that or show "New mail".
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } }));
const maxHours = vi.hoisted(() => ({ value: 0 }));
vi.mock('@/lib/auth/session-age', () => ({
  isPastMaxAge: (signedInAt: number, hours: number) => hours > 0 && Date.now() - signedInAt > hours * 3600_000,
  limitsEnforcedSince: async () => Date.now(),
  maxSessionHoursFor: async () => maxHours.value,
}));
const impersonation = vi.hoisted(() => ({ master: null as string | null }));
vi.mock('@/lib/impersonation/master-config', () => ({
  readImpersonationConfig: () => (impersonation.master ? { masterPassword: impersonation.master } : null),
}));

import { encryptSession } from '@/lib/auth/crypto';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { readPushAuthContext } from '@/lib/stalwart/push-auth-context';
import { stalwartAuthContextCookieName } from '@/lib/stalwart/auth-context';
import { encryptPayload } from '@/lib/auth/crypto';

function store(cookies: Record<string, string>) {
  return { get: (name: string) => (name in cookies ? { value: cookies[name] } : undefined) } as never;
}

const remembered = (signedInAt = Date.now(), password = 'pw') => encryptSession('https://mail.example.org', 'me@example.org', password, signedInAt);

beforeEach(() => {
  process.env.SESSION_SECRET = 'a-test-secret-that-is-long-enough-for-this-0123456789';
  maxHours.value = 0;
  impersonation.master = null;
});

describe('readPushAuthContext', () => {
  it('prefers the context cookie', async () => {
    const context = encryptPayload({ serverUrl: 'https://ctx.example.org', username: 'ctx@example.org', authHeader: 'Bearer t' }, 'session-context');
    const found = await readPushAuthContext(store({ [stalwartAuthContextCookieName(0)]: context, [sessionCookieName(0)]: remembered() }), 0);
    expect(found?.username).toBe('ctx@example.org');
  });

  it('falls back to the remembered session', async () => {
    const found = await readPushAuthContext(store({ [sessionCookieName(1)]: remembered() }), 1);
    expect(found).toMatchObject({ serverUrl: 'https://mail.example.org', username: 'me@example.org' });
    expect(found?.authHeader).toMatch(/^Basic /);
  });

  it('finds nothing in another slot, or without either cookie', async () => {
    expect(await readPushAuthContext(store({ [sessionCookieName(1)]: remembered() }), 0)).toBeNull();
    expect(await readPushAuthContext(store({}), 0)).toBeNull();
  });

  it('refuses a session past the organisation\'s maximum length', async () => {
    maxHours.value = 1;
    expect(await readPushAuthContext(store({ [sessionCookieName(0)]: remembered(Date.now() - 2 * 3600_000) }), 0)).toBeNull();
    expect(await readPushAuthContext(store({ [sessionCookieName(0)]: remembered() }), 0)).not.toBeNull();
  });

  it('refuses garbage and a cookie holding the impersonation master password', async () => {
    expect(await readPushAuthContext(store({ [sessionCookieName(0)]: 'garbage' }), 0)).toBeNull();
    impersonation.master = 'master-secret';
    expect(await readPushAuthContext(store({ [sessionCookieName(0)]: remembered(Date.now(), 'master-secret') }), 0)).toBeNull();
  });
});
