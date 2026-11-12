// @vitest-environment node
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';

// When an impersonation hand-off fails after Stalwart may have made the
// support session's app password, nothing is left behind: the app password
// is found by the hand-off's own description and deleted, or deleted by id
// when the webmail knows it. And the server log gets a fixed text and the
// HTTP status, never text from Stalwart's answer, which holds the new
// password.

const secret = vi.hoisted(() => ({ value: 's'.repeat(64) }));
vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => secret.value,
  hasSessionSecret: () => secret.value !== '',
}));
const logs = vi.hoisted(() => ({ lines: [] as unknown[][] }));
vi.mock('@/lib/logger', () => {
  const record = (...args: unknown[]) => { logs.lines.push(args); };
  return { logger: { warn: record, error: record, info: record, debug: record } };
});
vi.mock('@/lib/telemetry/login-tracker', () => ({ recordLogin: () => {} }));

let jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string | { name: string }) => { jar.delete(typeof name === 'string' ? name : name.name); },
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  }),
}));

const SERVER = 'https://mail.example.org';
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key === 'jmapServerUrl' ? SERVER : fallback),
    getPolicy: () => ({}),
  },
}));

const JWT_SECRET = 'j'.repeat(40);
const NEW_PASSWORD = 'NEWAPPPASSWORD0123456789';

function mintJwt(mailbox: string) {
  const now = Math.floor(Date.now() / 1000);
  const b64url = (s: string) => Buffer.from(s).toString('base64url');
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ iss: 'platform-api/webmail', iat: now, exp: now + 60, jti: randomUUID(), mailbox }));
  return `${h}.${p}.${createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`;
}

/** The mailbox's app passwords as Stalwart holds them. */
let stored: { id: string; description: string }[] = [];
/** How the create is answered after Stalwart made the app password. */
let createAnswer: 'ok' | 'garbled' | 'no-id' | 'http-500' = 'ok';
/** The listing fails with the new password in its body. */
let listFails = false;

function stalwart(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url.endsWith('/.well-known/jmap') || url.endsWith('/jmap/session')) {
    return Promise.resolve(Response.json({ apiUrl: `${SERVER}/jmap/`, accounts: { acc: {} }, primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc' } }));
  }
  const [name, args] = JSON.parse(String(init?.body)).methodCalls[0] as [string, Record<string, unknown>];
  if (name === 'x:AppPassword/get') {
    if (listFails) return Promise.resolve(new Response(`broken ${NEW_PASSWORD}`, { status: 500 }));
    return Promise.resolve(Response.json({ methodResponses: [[name, { list: stored }, '0']] }));
  }
  if (args.create) {
    const entry = (args.create as Record<string, { description: string }>).imp;
    if (createAnswer === 'http-500') return Promise.resolve(new Response(`oops ${NEW_PASSWORD}`, { status: 500 }));
    const id = `cred-${stored.length + 1}`;
    stored.push({ id, description: entry.description });
    if (createAnswer === 'garbled') {
      // A 200 whose secret lost its opening quote on the way: the parser quotes the text around the fault.
      return Promise.resolve(new Response(`{"methodResponses":[["${name}",{"created":{"imp":{"id":"${id}","secret":${NEW_PASSWORD}"}}},"0"]]}`, { status: 200 }));
    }
    if (createAnswer === 'no-id') return Promise.resolve(Response.json({ methodResponses: [[name, { created: { imp: { secret: NEW_PASSWORD } } }, '0']] }));
    return Promise.resolve(Response.json({ methodResponses: [[name, { created: { imp: { id, secret: NEW_PASSWORD } } }, '0']] }));
  }
  const destroy = (args.destroy as string[]) ?? [];
  stored = stored.filter((p) => !destroy.includes(p.id));
  return Promise.resolve(Response.json({ methodResponses: [[name, { destroyed: destroy }, '0']] }));
}

async function handOff(headers: Record<string, string> = {}) {
  const { GET } = await import('@/app/api/auth/impersonate/route');
  return GET(new NextRequest(`https://webmail.example/api/auth/impersonate?token=${mintJwt('alice@example.org')}`, { headers }));
}

/** Every 6-character piece of the new password that shows up in the log. */
function leakedPieces(): string[] {
  const text = JSON.stringify(logs.lines);
  const pieces: string[] = [];
  for (let i = 0; i + 6 <= NEW_PASSWORD.length; i++) if (text.includes(NEW_PASSWORD.slice(i, i + 6))) pieces.push(NEW_PASSWORD.slice(i, i + 6));
  return pieces;
}

describe('an impersonation hand-off that fails', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bw-imp-failure-'));
  afterAll(() => rmSync(stateDir, { recursive: true, force: true }));
  beforeAll(() => {
    process.env.ADMIN_STATE_DIR = stateDir;
    process.env.BULWARK_JWT_AUTH_SECRET = JWT_SECRET;
    process.env.BULWARK_STALWART_MASTER_USER = 'master@example.org';
    process.env.BULWARK_STALWART_MASTER_PASSWORD = 'made-up-master-password';
  });
  beforeEach(() => {
    jar = new Map();
    stored = [];
    createAnswer = 'ok';
    listFails = false;
    logs.lines = [];
    secret.value = 's'.repeat(64);
    resetLocalStoreForTests();
    vi.stubGlobal('fetch', vi.fn(stalwart));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('logs no part of the new app password when Stalwart\'s answer can\'t be read', async () => {
    createAnswer = 'garbled';
    expect((await handOff()).status).toBe(502);
    expect(leakedPieces()).toEqual([]);
    expect(JSON.stringify(logs.lines)).toContain('Impersonation credential could not be created');
  });

  it('deletes the app password Stalwart made when its answer can\'t be read', async () => {
    createAnswer = 'garbled';
    await handOff();
    expect(stored).toEqual([]);
    expect([...jar.keys()].filter((name) => name.startsWith('jmap_session') || name.startsWith('jmap_stalwart_ctx'))).toEqual([]);
  });

  it('does the same when the answer names no id', async () => {
    createAnswer = 'no-id';
    expect((await handOff()).status).toBe(502);
    expect(stored).toEqual([]);
  });

  it('logs the HTTP status of a refused create and nothing of its body', async () => {
    createAnswer = 'http-500';
    expect((await handOff()).status).toBe(502);
    const line = logs.lines.find(([message]) => message === 'Impersonation credential could not be created');
    expect(line?.[1]).toMatchObject({ status: 500 });
    expect(leakedPieces()).toEqual([]);
  });

  it('deletes the app password when the session can\'t be sealed afterwards, and keeps the browser\'s own session', async () => {
    jar.set('jmap_session', 'the-browsers-own-session');
    secret.value = '';
    const res = await handOff();
    expect(res.status).toBe(500);
    expect(stored).toEqual([]);
    expect(jar.get('jmap_session')).toBe('the-browsers-own-session');
    expect(jar.has('jmap_impersonation')).toBe(false);
  });

  it('leaves another app password of the mailbox alone, and hands over normally otherwise (control)', async () => {
    stored = [{ id: 'users-own', description: 'Thunderbird' }];
    expect((await handOff()).status).toBe(303);
    expect(stored.map((p) => p.id)).toEqual(['users-own', 'cred-2']);
    createAnswer = 'garbled';
    await handOff();
    expect(stored.map((p) => p.id)).toEqual(['users-own', 'cred-2']);
  });

  it('logs a fixed line with the status when the app password it may have made cannot be deleted', async () => {
    createAnswer = 'garbled';
    listFails = true;
    expect((await handOff()).status).toBe(502);
    const line = logs.lines.find(([message]) => String(message).startsWith('Impersonation app password not deleted'));
    expect(line?.[1]).toEqual({ status: 500 });
    expect(leakedPieces()).toEqual([]);
  });

  it('logs the client address the rate limits use, not the first forwarded entry', async () => {
    expect((await handOff({ 'x-forwarded-for': '198.51.100.66, 203.0.113.9' })).status).toBe(303);
    const line = logs.lines.find(([message]) => message === 'Impersonation session granted');
    expect((line?.[1] as { ip?: string }).ip).toBe('203.0.113.9');
  });
});
