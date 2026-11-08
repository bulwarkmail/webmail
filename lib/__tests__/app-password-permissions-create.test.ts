// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const posted = vi.hoisted(() => [] as unknown[]);
vi.mock('@/lib/stalwart/jmap-api', () => ({
  fetchJmapSession: vi.fn(async () => ({ primaryAccounts: { 'urn:ietf:params:jmap:mail': 'c' }, apiUrl: 'https://mail.example.org/jmap/' })),
  rebaseApiUrl: vi.fn(() => 'https://mail.example.org/jmap/'),
  postJmap: vi.fn(async (_url: string, _auth: string, body: string) => {
    posted.push(JSON.parse(body));
    return Response.json({ methodResponses: [['x:AppPassword/set', { created: { imp: { id: 'b', secret: 'app_x' } } }, '0']] });
  }),
}));

import { createAppPassword } from '../impersonation/app-password';

beforeEach(() => { posted.length = 0; });

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
    await createAppPassword({
      serverUrl: 'https://mail.example.org', authHeader: 'Bearer t', description: 'Plugin: Team',
      permissions: { authenticate: true, jmapCalendarGet: true },
    });
    expect(created()).toEqual({
      description: 'Plugin: Team',
      permissions: { '@type': 'Replace', permissions: { authenticate: true, jmapCalendarGet: true } },
    });
  });
});
