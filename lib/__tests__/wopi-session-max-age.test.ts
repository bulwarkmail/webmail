// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';

// An office editor token ends with the session that opened the editor: it is
// refused once that session is past the organisation's maximum length, and
// when the server ends a session for being too old (restoring it, renewing
// its token, or any cookie-authed route), that browser's tokens for the slot
// are revoked.

vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));
vi.mock('@/lib/telemetry/login-tracker', () => ({ recordLogin: () => {} }));
// An office server that edits .docx.
vi.mock('@/lib/wopi/discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/wopi/discovery')>()),
  getWopiActions: async () => ({ edit: { docx: 'https://office.example/cool.html?' }, view: {} }),
}));

const SERVER = 'https://mail.example.org';
const MAX_HOURS = 8;
/** Everyone's maximum session length; 0 is none. */
let maxHours = MAX_HOURS;

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key === 'jmapServerUrl' ? SERVER : fallback),
    getPolicy: () => ({ organisation: { session: { maxHours } } }),
  },
}));

let jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string | { name: string }) => { jar.delete(typeof name === 'string' ? name : name.name); },
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  }),
}));

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
const USER = 'user@example.org';
const PASSWORD = 'correct horse battery staple';
const BASIC = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Requests the mail server got with the user's credential. */
let upstream: string[];

function mailServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (new Headers(init?.headers).get('authorization') === BASIC) upstream.push(`${init?.method ?? 'GET'} ${url}`);
  if (url.endsWith('/.well-known/jmap')) {
    return Promise.resolve(Response.json({
      apiUrl: `${SERVER}/jmap/`,
      downloadUrl: `${SERVER}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
      uploadUrl: `${SERVER}/jmap/upload/{accountId}/`,
      username: USER,
      accounts: { acc: { name: USER, accountCapabilities: { 'urn:ietf:params:jmap:filenode': {} } } },
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc', 'urn:ietf:params:jmap:filenode': 'acc' },
    }));
  }
  if (url.includes('/jmap/download/')) return Promise.resolve(new Response('document'));
  const calls = typeof init?.body === 'string'
    ? (JSON.parse(init.body) as { methodCalls?: Array<[string, unknown, string]> }).methodCalls ?? []
    : [];
  return Promise.resolve(Response.json({
    methodResponses: calls.map(([name, , id]) => (name === 'FileNode/get'
      ? [name, {
          accountId: 'acc',
          list: [{ id: 'f1', parentId: null, name: 'Report.docx', type: DOCX, blobId: 'b1', size: 8, modified: '2026-11-11T07:00:00Z' }],
          notFound: [],
        }, id]
      : [name, { accountId: 'acc', ids: [], list: [], total: 0 }, id])),
  }));
}

const at = (time: string) => vi.setSystemTime(new Date(`2026-11-11T${time}Z`));

async function signIn(slot = 0) {
  const { POST } = await import('@/app/api/auth/session/route');
  const res = await POST(new NextRequest('https://webmail.example/api/auth/session', {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ serverUrl: SERVER, username: USER, password: PASSWORD, slot }),
  }));
  expect(res.status).toBe(200);
}

/** A token as /api/wopi/launch mints it for this browser's slot. */
async function editorToken(slot: number, signedInAt?: number) {
  const { mintWopiToken, wopiDocumentId } = await import('@/lib/wopi/token');
  const { wopiBrowserBinding } = await import('@/lib/wopi/revocation');
  const store = await (await import('next/headers')).cookies();
  const payload = {
    serverUrl: SERVER,
    authHeader: BASIC,
    username: USER,
    accountId: 'acc',
    kind: 'file' as const,
    fileId: 'f1',
    uploadAccountId: 'acc',
    canWrite: true,
    origin: 'https://webmail.example',
    bid: wopiBrowserBinding(store as never),
    slot,
    ...(signedInAt !== undefined ? { signedInAt } : {}),
  };
  return { token: mintWopiToken(payload).token, documentId: wopiDocumentId(payload) };
}

type Editor = Awaited<ReturnType<typeof editorToken>>;

async function checkFileInfo({ token, documentId }: Editor) {
  const { GET } = await import('@/app/api/wopi/files/[fileId]/route');
  return GET(new NextRequest(`https://webmail.example/api/wopi/files/${documentId}?access_token=${token}`), {
    params: Promise.resolve({ fileId: documentId }),
  });
}

async function getFile({ token, documentId }: Editor) {
  const { GET } = await import('@/app/api/wopi/files/[fileId]/contents/route');
  return GET(new NextRequest(`https://webmail.example/api/wopi/files/${documentId}/contents?access_token=${token}`), {
    params: Promise.resolve({ fileId: documentId }),
  });
}

async function putFile({ token, documentId }: Editor) {
  const { POST } = await import('@/app/api/wopi/files/[fileId]/contents/route');
  return POST(new NextRequest(`https://webmail.example/api/wopi/files/${documentId}/contents?access_token=${token}`, {
    method: 'POST',
    headers: { 'X-WOPI-Override': 'PUT' },
    body: 'new content',
  }), { params: Promise.resolve({ fileId: documentId }) });
}

describe('an office editor token and the session that opened it', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bw-wopi-session-age-'));
  afterAll(() => rmSync(stateDir, { recursive: true, force: true }));
  beforeAll(() => { process.env.ADMIN_STATE_DIR = stateDir; });
  // Loaded once up front, so no single test spends its time limit on it.
  beforeAll(async () => {
    await Promise.all([
      import('@/app/api/auth/session/route'),
      import('@/app/api/auth/token/route'),
      import('@/app/api/account/stalwart/jmap/route'),
      import('@/app/api/wopi/launch/route'),
      import('@/app/api/wopi/files/[fileId]/route'),
      import('@/app/api/wopi/files/[fileId]/contents/route'),
    ]);
  }, 60_000);

  beforeEach(async () => {
    jar = new Map();
    upstream = [];
    maxHours = MAX_HOURS;
    resetLocalStoreForTests();
    rmSync(path.join(stateDir, 'wopi-revocations.json'), { force: true });
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('bulwark.wopiRevocations')];
    vi.useFakeTimers({ toFake: ['Date'] });
    at('08:00:00');
    rmSync(path.join(stateDir, 'session-limits-since'), { force: true });
    const { limitsEnforcedSince, resetLimitsEnforcedSince } = await import('@/lib/auth/session-age');
    resetLimitsEnforcedSince();
    await limitsEnforcedSince();
    vi.stubGlobal('fetch', vi.fn(mailServer));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // Signed in at 08:00 with an eight-hour maximum; the editor opened at 12:00,
  // so its own six hours run until 18:00.
  it('works while that session is younger than the maximum (control)', async () => {
    await signIn();
    const signedInAt = Date.now();
    at('12:00:00');
    const editor = await editorToken(0, signedInAt);
    at('15:59:59');
    expect((await checkFileInfo(editor)).status).toBe(200);
    expect(upstream.length).toBeGreaterThan(0);
  });

  it('is refused by CheckFileInfo, GetFile and PutFile once that session is past the maximum', async () => {
    await signIn();
    const signedInAt = Date.now();
    at('12:00:00');
    const editor = await editorToken(0, signedInAt);
    at('16:00:01');
    upstream = [];
    expect((await checkFileInfo(editor)).status).toBe(401);
    expect((await getFile(editor)).status).toBe(401);
    expect((await putFile(editor)).status).toBe(401);
    expect(upstream).toEqual([]);
  });

  it('keeps working without a maximum until it expires', async () => {
    maxHours = 0;
    await signIn();
    const editor = await editorToken(0, Date.now() - 100 * 60 * 60 * 1000);
    at('13:00:00');
    expect((await checkFileInfo(editor)).status).toBe(200);
  });

  // The revocation cases mint the token with a later sign-in time than the
  // session's, so at 16:00:01 only the revocation can end it.
  it('is revoked when restoring the session finds it past the maximum', async () => {
    await signIn();
    at('12:00:00');
    const editor = await editorToken(0, Date.now());
    await signIn(1);
    const other = await editorToken(1, Date.now());
    at('16:00:01');
    expect((await checkFileInfo(editor)).status).toBe(200);

    const { PUT } = await import('@/app/api/auth/session/route');
    expect((await PUT(new NextRequest('https://webmail.example/api/auth/session?slot=0', { method: 'PUT', headers: SAME_ORIGIN }))).status).toBe(401);

    upstream = [];
    expect((await checkFileInfo(editor)).status).toBe(401);
    expect((await getFile(editor)).status).toBe(401);
    expect((await putFile(editor)).status).toBe(401);
    expect(upstream).toEqual([]);
    // Only that slot's editors.
    expect((await checkFileInfo(other)).status).toBe(200);
  });

  it('is revoked when a cookie-authed route finds the context past the maximum', async () => {
    await signIn();
    at('12:00:00');
    const editor = await editorToken(0, Date.now());
    at('16:00:01');
    expect((await checkFileInfo(editor)).status).toBe(200);
    const { POST } = await import('@/app/api/account/stalwart/jmap/route');
    const res = await POST(new NextRequest('https://webmail.example/api/account/stalwart/jmap', {
      method: 'POST',
      headers: { ...SAME_ORIGIN, 'content-type': 'application/json', 'X-JMAP-Cookie-Slot': '0' },
      body: JSON.stringify({ using: ['urn:ietf:params:jmap:core'], methodCalls: [] }),
    }));
    expect(res.status).toBe(401);
    expect((await checkFileInfo(editor)).status).toBe(401);
  });

  it('is revoked when renewing a token sign-in finds it past the maximum', async () => {
    const { writeSignInStamp } = await import('@/lib/auth/session-age');
    const store = await (await import('next/headers')).cookies();
    jar.set('jmap_rt', 'refresh-token');
    writeSignInStamp(store as never, 0, { signedInAt: Date.now(), refreshToken: 'refresh-token' });
    at('12:00:00');
    const editor = await editorToken(0, Date.now());
    at('16:00:01');
    expect((await checkFileInfo(editor)).status).toBe(200);
    const { PUT } = await import('@/app/api/auth/token/route');
    const res = await PUT(new NextRequest('https://webmail.example/api/auth/token?slot=0&force=true', { method: 'PUT', headers: SAME_ORIGIN }));
    expect(res.status).toBe(401);
    expect((await checkFileInfo(editor)).status).toBe(401);
  });

  it('is revoked in every slot by signing out everywhere (control)', async () => {
    await signIn();
    await signIn(1);
    const first = await editorToken(0, Date.now());
    const second = await editorToken(1, Date.now());
    at('09:00:00');
    const { DELETE } = await import('@/app/api/auth/session/route');
    await DELETE(new NextRequest('https://webmail.example/api/auth/session?all=true', { method: 'DELETE', headers: SAME_ORIGIN }));
    expect((await checkFileInfo(first)).status).toBe(401);
    expect((await checkFileInfo(second)).status).toBe(401);
  });

  it('carries the sign-in time from the launch, so an editor of a session past the maximum is refused everywhere', async () => {
    await signIn();
    at('12:00:00');
    const editor = await launch();
    at('15:59:59');
    expect((await checkFileInfo(editor)).status).toBe(200);
    at('16:00:01');
    upstream = [];
    expect((await checkFileInfo(editor)).status).toBe(401);
    expect((await getFile(editor)).status).toBe(401);
    expect((await putFile(editor)).status).toBe(401);
    expect(upstream).toEqual([]);
  });

  it('refuses a token that names no sign-in time, as tokens minted before it was recorded', async () => {
    await signIn();
    const editor = await editorToken(0);
    at('09:00:00');
    upstream = [];
    expect((await checkFileInfo(editor)).status).toBe(401);
    expect((await getFile(editor)).status).toBe(401);
    expect((await putFile(editor)).status).toBe(401);
    expect(upstream).toEqual([]);
  });

  it("ends the slot's editors on a sign-out that arrives without the browser's cookie", async () => {
    await signIn();
    at('08:30:00');
    await signIn(1);
    at('09:00:00');
    const editor = await launch(0);
    const other = await launch(1);
    expect((await checkFileInfo(editor)).status).toBe(200);
    jar.delete('bulwark_wopi');
    const { DELETE } = await import('@/app/api/auth/session/route');
    await DELETE(new NextRequest('https://webmail.example/api/auth/session?slot=0', { method: 'DELETE', headers: SAME_ORIGIN }));
    expect((await checkFileInfo(editor)).status).toBe(401);
    // Only the sign-in that was signed out.
    expect((await checkFileInfo(other)).status).toBe(200);
  });

  it('ends every editor on signing out everywhere without the browser\'s cookie', async () => {
    await signIn();
    await signIn(1);
    at('09:00:00');
    const first = await launch(0);
    const second = await launch(1);
    jar.delete('bulwark_wopi');
    const { DELETE } = await import('@/app/api/auth/session/route');
    await DELETE(new NextRequest('https://webmail.example/api/auth/session?all=true', { method: 'DELETE', headers: SAME_ORIGIN }));
    expect((await checkFileInfo(first)).status).toBe(401);
    expect((await checkFileInfo(second)).status).toBe(401);
  });
});

/** An editor opened from the app: POST /api/wopi/launch for the file, as the slot's session. */
async function launch(slot = 0): Promise<Editor> {
  const { POST } = await import('@/app/api/wopi/launch/route');
  const res = await POST(new NextRequest('https://webmail.example/api/wopi/launch', {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'content-type': 'application/json', 'X-JMAP-Cookie-Slot': String(slot) },
    body: JSON.stringify({ fileId: 'f1', accountId: 'acc' }),
  }));
  expect(res.status).toBe(200);
  const { url, accessToken } = await res.json() as { url: string; accessToken: string };
  const wopiSrc = new URL(url).searchParams.get('WOPISrc') ?? '';
  return { token: accessToken, documentId: wopiSrc.split('/').pop() ?? '' };
}
