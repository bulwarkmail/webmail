// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const posted = vi.hoisted(() => [] as unknown[]);
const stored = vi.hoisted(() => ({ permissions: undefined as unknown, getFails: false }));
vi.mock('@/lib/stalwart/jmap-api', () => ({
  fetchJmapSession: vi.fn(async () => ({ primaryAccounts: { 'urn:ietf:params:jmap:mail': 'c' }, apiUrl: 'https://mail.example.org/jmap/' })),
  rebaseApiUrl: vi.fn(() => 'https://mail.example.org/jmap/'),
  postJmap: vi.fn(async (_url: string, _auth: string, body: string) => {
    const request = JSON.parse(body) as { methodCalls: [string, Record<string, unknown>, string][] };
    posted.push(request);
    const [method, args] = request.methodCalls[0];
    if (method === 'x:AppPassword/get') {
      if (stored.getFails) return new Response('', { status: 500 });
      return Response.json({ methodResponses: [[method, { list: [{ id: 'b', permissions: stored.permissions }] }, '0']] });
    }
    if (args.destroy) return Response.json({ methodResponses: [[method, { destroyed: args.destroy }, '0']] });
    return Response.json({ methodResponses: [[method, { created: { imp: { id: 'b', secret: 'app_x' } } }, '0']] });
  }),
}));

import { createAppPassword } from '../impersonation/app-password';

beforeEach(() => {
  posted.length = 0;
  stored.permissions = undefined;
  stored.getFails = false;
});

const asked = { authenticate: true, jmapCalendarGet: true } as const;
const make = () => createAppPassword({
  serverUrl: 'https://mail.example.org', authHeader: 'Bearer t', description: 'Plugin: Team', permissions: asked,
});
const methods = () => (posted as { methodCalls: [string, Record<string, unknown>, string][] }[]).map((p) => p.methodCalls[0]);
const destroyed = () => methods().some(([m, a]) => m === 'x:AppPassword/set' && Array.isArray(a.destroy) && a.destroy.includes('b'));

function created(): Record<string, unknown> {
  const call = (posted[0] as { methodCalls: [string, { create: { imp: Record<string, unknown> } }, string][] }).methodCalls[0];
  return call[1].create.imp;
}

describe('createAppPassword', () => {
  it("leaves out permissions when none are given: the account's own rights", async () => {
    await createAppPassword({ serverUrl: 'https://mail.example.org', authHeader: 'Bearer t', description: 'x' });
    expect(created()).toEqual({ description: 'x' });
  });

  it('asks Stalwart for exactly the permissions given', async () => {
    stored.permissions = { '@type': 'Replace', permissions: { ...asked } };
    await make();
    expect(created()).toEqual({
      description: 'Plugin: Team',
      permissions: { '@type': 'Replace', permissions: { authenticate: true, jmapCalendarGet: true } },
    });
  });

  it('keeps the app password when Stalwart reports it limited to those permissions, or fewer', async () => {
    stored.permissions = { '@type': 'Replace', permissions: { authenticate: true } };
    await expect(make()).resolves.toEqual({ id: 'b', secret: 'app_x' });
    expect(methods().map(([m]) => m)).toEqual(['x:AppPassword/set', 'x:AppPassword/get']);
    expect(methods()[1][1]).toMatchObject({ ids: ['b'], properties: ['permissions'] });
  });

  it("deletes it again when the server ignored the limit and gave the account's rights", async () => {
    stored.permissions = { '@type': 'Inherit' };
    await expect(make()).rejects.toThrow('did not limit the app password');
    expect(destroyed()).toBe(true);
  });

  it('deletes it again when it holds a permission nobody asked for', async () => {
    stored.permissions = { '@type': 'Replace', permissions: { ...asked, emailSend: true } };
    await expect(make()).rejects.toThrow('did not limit the app password');
    expect(destroyed()).toBe(true);
  });

  it('deletes it again when its permissions cannot be read back', async () => {
    stored.getFails = true;
    await expect(make()).rejects.toThrow('did not limit the app password');
    expect(destroyed()).toBe(true);
  });

  it('reads nothing back without permissions', async () => {
    await createAppPassword({ serverUrl: 'https://mail.example.org', authHeader: 'Bearer t', description: 'x' });
    expect(methods().map(([m]) => m)).toEqual(['x:AppPassword/set']);
  });
});
