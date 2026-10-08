// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Every push carries the pushing tab's whole template list. The route used to
// store it as is, so a tab or device that had not loaded since another one
// added a template wiped that template for everyone. Templates are now merged
// into the stored blob.

vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key === 'settingsSyncEnabled' ? true : fallback),
    getPolicy: () => ({ restrictions: {} }),
  },
}));

const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  }),
}));

const store = new Map<string, Record<string, unknown>>();
vi.mock('@/lib/settings-sync', () => ({
  loadUserSettings: async (username: string, serverUrl: string) => store.get(`${username}|${serverUrl}`) ?? null,
  saveUserSettings: async (username: string, serverUrl: string, settings: Record<string, unknown>) => {
    store.set(`${username}|${serverUrl}`, settings);
  },
  deleteUserSettings: async () => {},
}));

const SERVER = 'https://mail.example.org';
const USER = 'alice@example.org';
const KEY = `${USER}|${SERVER}`;

function template(id: string, updatedAt = '2026-10-01T00:00:00.000Z') {
  return { id, name: id, subject: '', body: '', isHTML: false, category: '', isFavorite: false, createdAt: updatedAt, updatedAt };
}

async function push(settings: Record<string, unknown>) {
  const { POST } = await import('@/app/api/settings/route');
  const res = await POST(new NextRequest('https://webmail.example/api/settings', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, serverUrl: SERVER, settings }),
  }));
  expect(res.status).toBe(200);
  return store.get(KEY)!;
}

function ids(saved: Record<string, unknown>) {
  return (saved.templates as { id: string }[]).map((t) => t.id).sort();
}

beforeEach(async () => {
  store.clear();
  jar.clear();
  process.env.SETTINGS_SYNC_ENABLED = 'true';
  const { setStalwartAuthContextInStore } = await import('@/lib/stalwart/auth-context');
  setStalwartAuthContextInStore({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined),
    set: (n: string, v: string) => { jar.set(n, v); },
    delete: (n: string) => { jar.delete(n); },
  } as never, 0, { serverUrl: SERVER, authHeader: 'Bearer t', username: USER });
});

describe('settings route merges templates into the stored blob', () => {
  it('keeps a template another device added when a stale client pushes', async () => {
    store.set(KEY, { theme: 'light', templates: [template('a'), template('b')], deletedTemplateIds: {} });

    const saved = await push({ theme: 'dark', templates: [template('a')], deletedTemplateIds: {} });

    expect(saved.theme).toBe('dark');
    expect(ids(saved)).toEqual(['a', 'b']);
  });

  it('still removes a template the pushing client deleted', async () => {
    store.set(KEY, { templates: [template('a'), template('b')], deletedTemplateIds: {} });

    const saved = await push({ templates: [template('a')], deletedTemplateIds: { b: new Date().toISOString() } });

    expect(ids(saved)).toEqual(['a']);
    expect(Object.keys(saved.deletedTemplateIds as object)).toEqual(['b']);
  });

  it('takes the newer edit of the same template', async () => {
    store.set(KEY, { templates: [{ ...template('a', '2026-10-02T00:00:00.000Z'), name: 'newer' }], deletedTemplateIds: {} });

    const saved = await push({ templates: [{ ...template('a'), name: 'older' }], deletedTemplateIds: {} });

    expect((saved.templates as { name: string }[])[0].name).toBe('newer');
  });

  it('keeps stored templates when a push carries none', async () => {
    store.set(KEY, { templates: [template('a')], deletedTemplateIds: {} });

    const saved = await push({ theme: 'dark' });

    expect(ids(saved)).toEqual(['a']);
  });

  it('stores the first push as is', async () => {
    const saved = await push({ templates: [template('a')], deletedTemplateIds: {} });

    expect(ids(saved)).toEqual(['a']);
  });
});
