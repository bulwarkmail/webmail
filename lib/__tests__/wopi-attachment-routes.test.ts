// @vitest-environment node
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// #1047: mail attachments open read-only in the WOPI editor. The launch route
// mints a blob-scoped token; CheckFileInfo/GetFile serve the attachment blob
// and PutFile refuses to write anything back.

vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 'x'.repeat(32),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: vi.fn() }));
const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { get: (_key: string, fallback: unknown) => fallback, ensureLoaded: async () => {} },
}));
vi.mock('@/lib/wopi/discovery', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/wopi/discovery')>()),
  getWopiActions: vi.fn(),
}));
vi.mock('@/lib/stalwart/server-fetch', () => ({
  fetchJmapServer: vi.fn(),
  isTrustedJmapServerUrl: async () => true,
}));
vi.mock('@/lib/stalwart/jmap-api', () => ({
  fetchJmapSession: vi.fn(),
  postJmap: vi.fn(),
  rebaseApiUrl: () => null,
}));

import { POST as launch } from '@/app/api/wopi/launch/route';
import { GET as checkFileInfo } from '@/app/api/wopi/files/[fileId]/route';
import { GET as getFile, POST as putFile } from '@/app/api/wopi/files/[fileId]/contents/route';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { getWopiActions } from '@/lib/wopi/discovery';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';
import { fetchJmapSession, postJmap } from '@/lib/stalwart/jmap-api';
import { cookies } from 'next/headers';
import { revokeWopiTokens } from '@/lib/wopi/revocation';

// Revocations are kept in the state directory.
process.env.ADMIN_STATE_DIR = mkdtempSync(path.join(tmpdir(), 'bw-wopi-'));

const ORIGIN = 'https://webmail.example.com';
const OFFICE = 'https://office.example.com/browser/abc/cool.html?';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function request(url: string, init: { body?: unknown; bytes?: ArrayBuffer; headers?: Record<string, string> } = {}) {
  const parsed = new URL(url, ORIGIN);
  return {
    nextUrl: parsed,
    headers: new Headers(init.headers),
    json: async () => init.body,
    arrayBuffer: async () => init.bytes ?? new ArrayBuffer(0),
  } as unknown as Parameters<typeof launch>[0];
}

const params = (id: string) => ({ params: Promise.resolve({ fileId: id }) });

async function launchAttachment(body: Record<string, unknown>) {
  const res = await launch(request('/api/wopi/launch', { body }));
  const data = await res.json();
  return { status: res.status, data };
}

/** Pull the document id and token the editor would use out of a launch response. */
function editorCall(data: { url: string; accessToken: string }) {
  const wopiSrc = new URL(new URL(data.url).searchParams.get('WOPISrc')!);
  const documentId = decodeURIComponent(wopiSrc.pathname.split('/').pop()!);
  const token = `access_token=${encodeURIComponent(data.accessToken)}`;
  return { documentId, wopiSrc, token };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getStalwartCredentials as Mock).mockResolvedValue({
    serverUrl: 'https://mail.example.com',
    authHeader: 'Basic dXNlcjpwYXNz',
    username: 'user@example.com',
    trusted: true,
    slot: 0,
    hasSessionCookie: true,
  });
  (getWopiActions as Mock).mockResolvedValue({ edit: { docx: OFFICE, odt: OFFICE }, view: {} });
  (fetchJmapSession as Mock).mockResolvedValue({
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'c', 'urn:ietf:params:jmap:filenode': 'f' },
    accounts: { c: {} },
    downloadUrl: 'https://public.example.com/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
  });
  (fetchJmapServer as Mock).mockImplementation(async () =>
    new Response('DOCX-BYTES', { status: 200, headers: { 'Content-Length': '10' } }),
  );
});

describe('WOPI attachment launch', () => {
  it('mints a read-only token for the attachment blob in the primary mail account', async () => {
    const { status, data } = await launchAttachment({ blobId: 'Gblob1', name: 'Quote.docx', type: DOCX });
    expect(status).toBe(200);
    expect(data.readOnly).toBe(true);
    expect(data.url.startsWith(OFFICE)).toBe(true);

    // The blob was probed in the mail account, not the files account.
    const probeUrl = (fetchJmapServer as Mock).mock.calls[0][0] as string;
    expect(probeUrl).toBe(`https://mail.example.com/jmap/download/c/Gblob1/Quote.docx?accept=${encodeURIComponent(DOCX)}`);
    // Attachments never touch FileNode.
    expect(postJmap).not.toHaveBeenCalled();

    const { documentId, wopiSrc } = editorCall(data);
    expect(wopiSrc.origin).toBe(ORIGIN);
    // Not the raw blob id: sessions are keyed by WOPISrc.
    expect(documentId).not.toBe('Gblob1');
  });

  it('uses the accountId the client sends (shared / unified-inbox messages)', async () => {
    await launchAttachment({ blobId: 'Gblob1', name: 'Quote.docx', accountId: 'shared1' });
    expect((fetchJmapServer as Mock).mock.calls[0][0]).toContain('/jmap/download/shared1/Gblob1/');
  });

  it('404s when the blob cannot be downloaded', async () => {
    (fetchJmapServer as Mock).mockResolvedValue(new Response('nope', { status: 404 }));
    const { status } = await launchAttachment({ blobId: 'Gmissing', name: 'Quote.docx' });
    expect(status).toBe(404);
  });

  it('415s for types the editor does not handle, and 400s without a name', async () => {
    expect((await launchAttachment({ blobId: 'Gblob1', name: 'archive.zip' })).status).toBe(415);
    expect((await launchAttachment({ blobId: 'Gblob1' })).status).toBe(400);
  });
});

describe('WOPI calls for an attachment token', () => {
  async function launched(overrides: Record<string, unknown> = {}) {
    const { data } = await launchAttachment({ blobId: 'Gblob1', name: 'Quote.docx', type: DOCX, size: 999, ...overrides });
    (fetchJmapServer as Mock).mockClear();
    return editorCall(data);
  }

  it('CheckFileInfo describes the attachment as read-only, with the probed size', async () => {
    const { documentId, token } = await launched();
    const res = await checkFileInfo(request(`/api/wopi/files/${documentId}?${token}`), params(documentId));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      BaseFileName: 'Quote.docx',
      Size: 10,
      UserCanWrite: false,
      ReadOnly: true,
      UserCanNotWriteRelative: true,
      Version: 'Gblob1',
      PostMessageOrigin: ORIGIN,
    });
    expect(postJmap).not.toHaveBeenCalled();
  });

  it('GetFile streams the attachment blob', async () => {
    const { documentId, token } = await launched();
    const res = await getFile(request(`/api/wopi/files/${documentId}/contents?${token}`), params(documentId));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('DOCX-BYTES');
    expect((fetchJmapServer as Mock).mock.calls[0][0]).toContain('/jmap/download/c/Gblob1/Quote.docx');
  });

  it('GetFile serves the bytes as an inert download whatever type the launch claimed', async () => {
    const { documentId, token } = await launched({ type: 'text/html' });
    const res = await getFile(request(`/api/wopi/files/${documentId}/contents?${token}`), params(documentId));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Disposition')).toBe('attachment');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
  });

  it.each(['document', 'iframe', 'script'])('GetFile refuses a browser load as %s', async (dest) => {
    const { documentId, token } = await launched();
    const res = await getFile(
      request(`/api/wopi/files/${documentId}/contents?${token}`, { headers: { 'sec-fetch-dest': dest } }),
      params(documentId),
    );
    expect(res.status).toBe(403);
  });

  it('PutFile is refused', async () => {
    const { documentId, token } = await launched();
    const res = await putFile(
      request(`/api/wopi/files/${documentId}/contents?${token}`, { bytes: new TextEncoder().encode('x').buffer as ArrayBuffer }),
      params(documentId),
    );
    expect(res.status).toBe(403);
    expect(fetchJmapServer).not.toHaveBeenCalled();
    expect(postJmap).not.toHaveBeenCalled();
  });

  it('the token does not work under the raw blob id or another document id', async () => {
    const { token } = await launched();
    for (const id of ['Gblob1', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']) {
      const res = await checkFileInfo(request(`/api/wopi/files/${id}?${token}`), params(id));
      expect(res.status).toBe(401);
    }
  });
});

// The token carries the user's credentials to the editor server; it used to
// keep working for six hours after the user signed out.
describe('WOPI tokens after signing out', () => {
  beforeEach(() => jar.clear());

  async function open() {
    const { data } = await launchAttachment({ blobId: 'Gblob1', name: 'Quote.docx', type: DOCX });
    const { documentId, token } = editorCall(data);
    return () => checkFileInfo(request(`/api/wopi/files/${documentId}?${token}`), params(documentId));
  }

  it('refuses a token once its slot signed out in that browser', async () => {
    const call = await open();
    expect((await call()).status).toBe(200);
    await new Promise((r) => setTimeout(r, 2));

    await revokeWopiTokens(await cookies(), 0);
    expect((await call()).status).toBe(401);
  });

  it('keeps tokens of other slots, and tokens minted after signing in again', async () => {
    const call = await open();
    await revokeWopiTokens(await cookies(), 1);
    expect((await call()).status).toBe(200);

    await new Promise((r) => setTimeout(r, 2));
    await revokeWopiTokens(await cookies(), 0);
    await new Promise((r) => setTimeout(r, 2));
    const again = await open();
    expect((await again()).status).toBe(200);
  });

  it('a full sign-out refuses every slot and forgets the browser id', async () => {
    const call = await open();
    await new Promise((r) => setTimeout(r, 2));
    await revokeWopiTokens(await cookies(), 'all');
    expect((await call()).status).toBe(401);
    expect(jar.has('bulwark_wopi')).toBe(false);
  });

  it('signing out on another browser leaves this one alone', async () => {
    const call = await open();
    const mine = jar.get('bulwark_wopi')!;
    jar.set('bulwark_wopi', 'another-browser');
    await revokeWopiTokens(await cookies(), 'all');
    jar.set('bulwark_wopi', mine);
    expect((await call()).status).toBe(200);
  });
});
