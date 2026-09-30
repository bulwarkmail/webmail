// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  secret: true,
  context: false,
  jar: new Map<string, string>(),
}));

vi.mock('@/lib/auth/session-secret', () => ({ hasSessionSecret: () => state.secret }));
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: async () => (state.context ? { serverUrl: 'https://mail.example' } : null),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (state.jar.has(name) ? { value: state.jar.get(name) } : undefined) }),
}));
vi.mock('@/lib/auth/crypto', () => ({ decryptSession: (token: string) => (token === 'valid' ? {} : null) }));
vi.mock('@/lib/admin/session', () => ({ verifyAdminSession: (token: string) => (token === 'admin' ? {} : null) }));

import { canSeeInstanceDetails } from '@/lib/auth/instance-details';

const request = new NextRequest('https://mail.example/api/plugins');

beforeEach(() => {
  state.secret = true;
  state.context = false;
  state.jar.clear();
});

describe('canSeeInstanceDetails', () => {
  it('refuses a visitor without a session', async () => {
    expect(await canSeeInstanceDetails(request)).toBe(false);
    state.jar.set('jmap_session', 'forged');
    state.jar.set('admin_session', 'forged');
    expect(await canSeeInstanceDetails(request)).toBe(false);
  });

  it('accepts a mailbox session, a remembered session cookie or the admin', async () => {
    state.context = true;
    expect(await canSeeInstanceDetails(request)).toBe(true);

    state.context = false;
    state.jar.set('jmap_session_2', 'valid');
    expect(await canSeeInstanceDetails(request)).toBe(true);

    state.jar.clear();
    state.jar.set('admin_session', 'admin');
    expect(await canSeeInstanceDetails(request)).toBe(true);
  });

  it('keeps answering everyone where no session secret exists to tell sessions apart', async () => {
    state.secret = false;
    expect(await canSeeInstanceDetails(request)).toBe(true);
  });
});
